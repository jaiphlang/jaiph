import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { parseUrlAndVersion, runInstall, type CloneRunner, type CloneOutcome, type InstallSpec } from "./install";

const CLI_PATH = join(__dirname, "../../../src/cli.js");

test("parseUrlAndVersion: https repo.git@ref (tag or branch)", () => {
  assert.deepEqual(parseUrlAndVersion("https://github.com/you/queue-lib.git@v1.0"), {
    url: "https://github.com/you/queue-lib.git",
    version: "v1.0",
  });
  assert.deepEqual(parseUrlAndVersion("https://a/b/c.git@feature/xyz"), {
    url: "https://a/b/c.git",
    version: "feature/xyz",
  });
});

test("parseUrlAndVersion: git@host:path.git@ref", () => {
  assert.deepEqual(parseUrlAndVersion("git@github.com:org/repo.git@main"), {
    url: "git@github.com:org/repo.git",
    version: "main",
  });
});

test("parseUrlAndVersion: schemaless path@ref when no : before @", () => {
  assert.deepEqual(parseUrlAndVersion("acme/queue-lib@v0.1"), {
    url: "acme/queue-lib",
    version: "v0.1",
  });
});

function makeTempProject(): string {
  const dir = join(tmpdir(), `jaiph-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  // Initialize git repo so detectWorkspaceRoot works
  execSync("git init", { cwd: dir, stdio: "pipe" });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("install: corrupt lockfile produces an error", () => {
  const dir = makeTempProject();
  try {
    const jaiPhDir = join(dir, ".jaiph");
    mkdirSync(jaiPhDir, { recursive: true });
    writeFileSync(join(jaiPhDir, "libs.lock"), "NOT VALID JSON{{{", "utf8");

    // runInstall with no args reads the lockfile
    // This should throw because JSON.parse fails on corrupt data
    assert.throws(
      () => {
        execSync(`node ${CLI_PATH} install`, {
          cwd: dir,
          stdio: "pipe",
          env: { ...process.env, HOME: dir },
        });
      },
      /./,  // any error
      "corrupt lockfile should cause install to fail",
    );
  } finally {
    cleanup(dir);
  }
});

test("install: missing lockfile shows no libs message", () => {
  const dir = makeTempProject();
  try {
    const result = execSync(`node ${CLI_PATH} install`, {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
    });
    assert.ok(result.includes("No libs in lockfile"), "should report empty lockfile");
  } finally {
    cleanup(dir);
  }
});

test("install: missing libraries clone concurrently", async () => {
  const dir = makeTempProject();
  try {
    let active = 0;
    let maxActive = 0;
    const cloneRunner: CloneRunner = async (spec: InstallSpec): Promise<CloneOutcome> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Mimic git clone side effect so the lib directory is materialized.
      mkdirSync(spec.libDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { spec, ok: true };
    };

    const code = await runInstall(
      [
        "https://example.com/alpha.git",
        "https://example.com/beta.git",
        "https://example.com/gamma.git",
      ],
      { cwd: dir, cloneRunner, concurrency: 4 },
    );

    assert.equal(code, 0);
    assert.ok(maxActive >= 2, `expected overlapping clones; observed peak ${maxActive}`);

    const lock = JSON.parse(readFileSync(join(dir, ".jaiph", "libs.lock"), "utf8")) as {
      libs: { name: string }[];
    };
    assert.deepEqual(
      lock.libs.map((e) => e.name).sort(),
      ["alpha", "beta", "gamma"],
      "all three should land in the lockfile",
    );
  } finally {
    cleanup(dir);
  }
});

test("install: explicit warm path skips existing directories without invoking git", async () => {
  const dir = makeTempProject();
  try {
    const libDir = join(dir, ".jaiph", "libs", "alpha");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, "sentinel"), "warm\n", "utf8");

    let callCount = 0;
    const cloneRunner: CloneRunner = async (spec) => {
      callCount += 1;
      return { spec, ok: true };
    };

    const code = await runInstall(["https://example.com/alpha.git"], { cwd: dir, cloneRunner });

    assert.equal(code, 0);
    assert.equal(callCount, 0, "cloneRunner must not be called when target dir exists and --force is absent");
    assert.equal(readFileSync(join(libDir, "sentinel"), "utf8"), "warm\n");
  } finally {
    cleanup(dir);
  }
});

test("install: restore-from-lock warm path skips existing directories without invoking git", async () => {
  const dir = makeTempProject();
  try {
    const lockPath = join(dir, ".jaiph", "libs.lock");
    mkdirSync(join(dir, ".jaiph"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        libs: [
          { name: "alpha", url: "https://example.com/alpha.git" },
          { name: "beta", url: "https://example.com/beta.git" },
        ],
      }) + "\n",
      "utf8",
    );
    const alphaDir = join(dir, ".jaiph", "libs", "alpha");
    const betaDir = join(dir, ".jaiph", "libs", "beta");
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(join(alphaDir, "sentinel"), "alpha-warm\n", "utf8");
    writeFileSync(join(betaDir, "sentinel"), "beta-warm\n", "utf8");

    let callCount = 0;
    const cloneRunner: CloneRunner = async (spec) => {
      callCount += 1;
      return { spec, ok: true };
    };

    const code = await runInstall([], { cwd: dir, cloneRunner });

    assert.equal(code, 0);
    assert.equal(callCount, 0, "cloneRunner must not be called for restore-from-lock warm path");
    // restore-from-lock with no args must not invent new lock entries; pre-existing two stay.
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { libs: { name: string }[] };
    assert.deepEqual(lock.libs.map((e) => e.name).sort(), ["alpha", "beta"]);
    assert.equal(readFileSync(join(alphaDir, "sentinel"), "utf8"), "alpha-warm\n");
    assert.equal(readFileSync(join(betaDir, "sentinel"), "utf8"), "beta-warm\n");
  } finally {
    cleanup(dir);
  }
});

test("install: invalid remote/path failure exits non-zero and does not lock the failed lib", async () => {
  const dir = makeTempProject();
  try {
    const bogus = join(dir, "does-not-exist-bogus-remote");
    const code = await runInstall([bogus], { cwd: dir });

    assert.notEqual(code, 0, "invalid remote/path must exit non-zero");
    const lockPath = join(dir, ".jaiph", "libs.lock");
    assert.ok(existsSync(lockPath), "lockfile is written but should not contain failed entries");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { libs: { name: string }[] };
    assert.equal(lock.libs.length, 0, "failed clone must not produce a lock entry");
    assert.ok(
      !existsSync(join(dir, ".jaiph", "libs", "does-not-exist-bogus-remote")),
      "no lib directory should remain after a failed clone",
    );
  } finally {
    cleanup(dir);
  }
});

test("install: unknown ref failure exits non-zero and does not lock the failed lib", async () => {
  const dir = makeTempProject();
  try {
    // Create a local repo with one commit so clone-from-path is valid, but the ref is not.
    const remoteDir = join(dir, "remote-repo");
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init", { cwd: remoteDir, stdio: "pipe" });
    writeFileSync(join(remoteDir, "README"), "hi\n", "utf8");
    execSync("git add README", { cwd: remoteDir, stdio: "pipe" });
    execSync(
      `git -c user.email=test@example.com -c user.name=test commit -m init`,
      { cwd: remoteDir, stdio: "pipe" },
    );

    const code = await runInstall([`${remoteDir}@nonexistent-ref-xyz`], { cwd: dir });

    assert.notEqual(code, 0, "unknown ref must exit non-zero");
    const lockPath = join(dir, ".jaiph", "libs.lock");
    assert.ok(existsSync(lockPath));
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { libs: { name: string }[] };
    assert.equal(lock.libs.length, 0, "unknown-ref clone must not produce a lock entry");
  } finally {
    cleanup(dir);
  }
});

test("install: mixed success and failure locks only the successful libs", async () => {
  const dir = makeTempProject();
  try {
    const cloneRunner: CloneRunner = async (spec) => {
      if (spec.name === "bad") {
        return { spec, ok: false, message: "simulated failure" };
      }
      mkdirSync(spec.libDir, { recursive: true });
      return { spec, ok: true };
    };

    const code = await runInstall(
      ["https://example.com/good.git", "https://example.com/bad.git", "https://example.com/also-good.git"],
      { cwd: dir, cloneRunner, concurrency: 4 },
    );

    assert.notEqual(code, 0, "any failure must propagate non-zero exit");
    const lock = JSON.parse(readFileSync(join(dir, ".jaiph", "libs.lock"), "utf8")) as {
      libs: { name: string }[];
    };
    assert.deepEqual(lock.libs.map((e) => e.name).sort(), ["also-good", "good"]);
  } finally {
    cleanup(dir);
  }
});
