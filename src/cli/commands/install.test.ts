import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { parseUrlAndVersion, runInstall, type CloneRunner, type CloneOutcome, type InstallSpec } from "./install";

/**
 * Run a body with JAIPH_REGISTRY set to `value`. Restore the prior value
 * (including absent) on exit. Wraps each registry-dependent test so they can
 * share the global env without leaking between cases.
 */
async function withRegistry<T>(value: string, body: () => Promise<T>): Promise<T> {
  const prev = process.env.JAIPH_REGISTRY;
  process.env.JAIPH_REGISTRY = value;
  try {
    return await body();
  } finally {
    if (prev === undefined) {
      delete process.env.JAIPH_REGISTRY;
    } else {
      process.env.JAIPH_REGISTRY = prev;
    }
  }
}

function writeRegistryFile(dir: string, libs: Record<string, { url: string; description: string }>): string {
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ libs }), "utf8");
  return path;
}

/** Capture process.stderr writes during `body`. Restores the prior writer on exit. */
async function captureStderr<T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await body();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = orig;
  }
}

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
      // Post-clone hygiene requires at least one .jh file in the tree.
      mkdirSync(spec.libDir, { recursive: true });
      writeFileSync(join(spec.libDir, "lib.jh"), "", "utf8");
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

test("install: bare registry name installs into .jaiph/libs/<name>/ regardless of url last segment", async () => {
  const dir = makeTempProject();
  try {
    const registryPath = writeRegistryFile(dir, {
      mylib: { url: "https://example.com/some-other-repo-name.git", description: "demo" },
    });

    const seen: InstallSpec[] = [];
    const cloneRunner: CloneRunner = async (spec) => {
      seen.push(spec);
      mkdirSync(spec.libDir, { recursive: true });
      writeFileSync(join(spec.libDir, "lib.jh"), "", "utf8");
      return { spec, ok: true };
    };

    const code = await withRegistry(registryPath, () =>
      runInstall(["mylib"], { cwd: dir, cloneRunner }),
    );

    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.name, "mylib");
    assert.equal(seen[0]!.url, "https://example.com/some-other-repo-name.git");
    assert.equal(seen[0]!.libDir, join(dir, ".jaiph", "libs", "mylib"));

    assert.ok(existsSync(join(dir, ".jaiph", "libs", "mylib")), "lib dir uses registry name, not url segment");
    const lock = JSON.parse(readFileSync(join(dir, ".jaiph", "libs.lock"), "utf8")) as {
      libs: { name: string; url: string }[];
    };
    assert.equal(lock.libs.length, 1);
    assert.equal(lock.libs[0]!.name, "mylib");
    assert.equal(lock.libs[0]!.url, "https://example.com/some-other-repo-name.git");
  } finally {
    cleanup(dir);
  }
});

test("install: name@version forwards version to clone runner and records it in lock", async () => {
  const dir = makeTempProject();
  try {
    const registryPath = writeRegistryFile(dir, {
      mylib: { url: "https://example.com/mylib.git", description: "demo" },
    });

    let observed: InstallSpec | undefined;
    const cloneRunner: CloneRunner = async (spec) => {
      observed = spec;
      mkdirSync(spec.libDir, { recursive: true });
      writeFileSync(join(spec.libDir, "lib.jh"), "", "utf8");
      return { spec, ok: true };
    };

    const code = await withRegistry(registryPath, () =>
      runInstall(["mylib@v1.2"], { cwd: dir, cloneRunner }),
    );

    assert.equal(code, 0);
    assert.equal(observed?.version, "v1.2");
    const lock = JSON.parse(readFileSync(join(dir, ".jaiph", "libs.lock"), "utf8")) as {
      libs: { name: string; version?: string }[];
    };
    assert.equal(lock.libs[0]!.version, "v1.2");
  } finally {
    cleanup(dir);
  }
});

test("install: unknown registry name fails with actionable message naming the source", async () => {
  const dir = makeTempProject();
  try {
    const registryPath = writeRegistryFile(dir, {
      other: { url: "https://example.com/other.git", description: "demo" },
    });

    const { result: code, stderr } = await captureStderr(() =>
      withRegistry(registryPath, () => runInstall(["missing"], { cwd: dir })),
    );

    assert.notEqual(code, 0);
    assert.ok(
      stderr.includes(`lib "missing" not found in registry ${registryPath}`),
      `expected unknown-name error naming the source; got: ${stderr}`,
    );
  } finally {
    cleanup(dir);
  }
});

test("install: unreadable registry source fails with message naming source and cause", async () => {
  const dir = makeTempProject();
  try {
    const missingPath = join(dir, "no-such-registry.json");

    const { result: code, stderr } = await captureStderr(() =>
      withRegistry(missingPath, () => runInstall(["mylib"], { cwd: dir })),
    );

    assert.notEqual(code, 0);
    assert.ok(stderr.includes(missingPath), `expected error naming registry source; got: ${stderr}`);
    assert.ok(stderr.includes("failed to read registry"), `expected read-failure message; got: ${stderr}`);
  } finally {
    cleanup(dir);
  }
});

test("install: invalid registry JSON fails with message naming source and cause", async () => {
  const dir = makeTempProject();
  try {
    const registryPath = join(dir, "registry.json");
    writeFileSync(registryPath, "{ not valid json", "utf8");

    const { result: code, stderr } = await captureStderr(() =>
      withRegistry(registryPath, () => runInstall(["mylib"], { cwd: dir })),
    );

    assert.notEqual(code, 0);
    assert.ok(stderr.includes(registryPath), `expected error naming registry source; got: ${stderr}`);
    assert.ok(stderr.includes("failed to parse registry"), `expected parse-failure message; got: ${stderr}`);
  } finally {
    cleanup(dir);
  }
});

test("install: restore-from-lock never reads the registry", async () => {
  const dir = makeTempProject();
  try {
    const lockPath = join(dir, ".jaiph", "libs.lock");
    mkdirSync(join(dir, ".jaiph"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        libs: [
          { name: "alpha", url: "https://example.com/alpha.git" },
          { name: "beta", url: "https://example.com/beta.git", version: "v2" },
        ],
      }) + "\n",
      "utf8",
    );

    const seen: InstallSpec[] = [];
    const cloneRunner: CloneRunner = async (spec) => {
      seen.push(spec);
      mkdirSync(spec.libDir, { recursive: true });
      writeFileSync(join(spec.libDir, "lib.jh"), "", "utf8");
      return { spec, ok: true };
    };

    // Point JAIPH_REGISTRY at a path that does not exist. If restore touched
    // the registry, the load would fail. Restore must succeed regardless.
    const bogusRegistry = join(dir, "nope-no-registry-here.json");
    const code = await withRegistry(bogusRegistry, () =>
      runInstall([], { cwd: dir, cloneRunner }),
    );

    assert.equal(code, 0, "restore-from-lock must succeed without contacting the registry");
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((s) => s.name).sort(),
      ["alpha", "beta"],
    );
  } finally {
    cleanup(dir);
  }
});

/**
 * Build a local git repo at <parent>/<name> usable as a clone source for
 * tests. `withJh` controls whether the seed commit includes a `*.jh` file
 * (set false to exercise the "not a jaiph library" path). `tag` optionally
 * tags the seed commit so the test can `clone --branch <tag>`.
 */
function makeFixtureRepo(
  parent: string,
  name: string,
  opts: { withJh?: boolean; tag?: string } = {},
): string {
  const repoDir = join(parent, name);
  mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name test", { cwd: repoDir, stdio: "pipe" });
  if (opts.withJh !== false) {
    writeFileSync(join(repoDir, "main.jh"), "workflow default { log \"hi\" }\n", "utf8");
  } else {
    writeFileSync(join(repoDir, "README"), "no jh here\n", "utf8");
  }
  execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: repoDir, stdio: "pipe" });
  if (opts.tag) execSync(`git tag ${opts.tag}`, { cwd: repoDir, stdio: "pipe" });
  return repoDir;
}

function gitHead(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

test("install: strips .git after clone and records 40-char commit in lockfile", async () => {
  const dir = makeTempProject();
  try {
    const remote = makeFixtureRepo(dir, "remote-alpha");
    const expectedSha = gitHead(remote);

    const code = await runInstall([remote], { cwd: dir });

    assert.equal(code, 0, "install must succeed");
    const libDir = join(dir, ".jaiph", "libs", "remote-alpha");
    assert.ok(existsSync(libDir), "lib dir should exist");
    assert.ok(
      !existsSync(join(libDir, ".git")),
      ".git directory must be removed from installed lib",
    );

    const lock = JSON.parse(
      readFileSync(join(dir, ".jaiph", "libs.lock"), "utf8"),
    ) as { libs: { name: string; commit?: string }[] };
    assert.equal(lock.libs.length, 1);
    assert.equal(lock.libs[0]!.name, "remote-alpha");
    assert.match(
      lock.libs[0]!.commit ?? "",
      /^[0-9a-f]{40}$/,
      "lock entry must record a 40-char commit",
    );
    assert.equal(lock.libs[0]!.commit, expectedSha);
  } finally {
    cleanup(dir);
  }
});

test("install: restore detects moved tag and fails with both SHAs", async () => {
  const dir = makeTempProject();
  try {
    const remote = makeFixtureRepo(dir, "remote-beta", { tag: "v1" });
    const firstSha = gitHead(remote);

    const firstCode = await runInstall([`${remote}@v1`], { cwd: dir });
    assert.equal(firstCode, 0, "initial install must succeed");

    const lockPath = join(dir, ".jaiph", "libs.lock");
    const lockAfterFirst = JSON.parse(readFileSync(lockPath, "utf8")) as {
      libs: { name: string; commit?: string; version?: string }[];
    };
    assert.equal(lockAfterFirst.libs[0]!.commit, firstSha);

    // Move the tag to a new commit in the source repo.
    writeFileSync(join(remote, "second.jh"), "workflow default { log \"two\" }\n", "utf8");
    execSync("git add -A", { cwd: remote, stdio: "pipe" });
    execSync("git commit -m second", { cwd: remote, stdio: "pipe" });
    execSync("git tag -d v1", { cwd: remote, stdio: "pipe" });
    execSync("git tag v1", { cwd: remote, stdio: "pipe" });
    const secondSha = gitHead(remote);
    assert.notEqual(firstSha, secondSha);

    // Remove the installed copy so restore must re-clone.
    const libDir = join(dir, ".jaiph", "libs", "remote-beta");
    rmSync(libDir, { recursive: true, force: true });

    const { result: restoreCode, stderr } = await captureStderr(() =>
      runInstall([], { cwd: dir }),
    );

    assert.notEqual(restoreCode, 0, "restore must exit non-zero on commit mismatch");
    assert.ok(stderr.includes(firstSha), `expected locked SHA in stderr; got: ${stderr}`);
    assert.ok(stderr.includes(secondSha), `expected cloned SHA in stderr; got: ${stderr}`);
    assert.ok(!existsSync(libDir), "lib dir must be removed after mismatch");
  } finally {
    cleanup(dir);
  }
});

test("install: fixture repo with no .jh modules fails and leaves no lib dir or lock entry", async () => {
  const dir = makeTempProject();
  try {
    const remote = makeFixtureRepo(dir, "remote-empty", { withJh: false });

    const { result: code, stderr } = await captureStderr(() =>
      runInstall([remote], { cwd: dir }),
    );

    assert.notEqual(code, 0, "install must exit non-zero when no .jh modules are present");
    assert.ok(
      stderr.includes('lib "remote-empty" contains no .jh modules — not a jaiph library?'),
      `expected no-modules error; got: ${stderr}`,
    );
    assert.ok(
      !existsSync(join(dir, ".jaiph", "libs", "remote-empty")),
      "lib dir must be removed on no-jh failure",
    );
    const lockPath = join(dir, ".jaiph", "libs.lock");
    assert.ok(existsSync(lockPath));
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { libs: { name: string }[] };
    assert.equal(lock.libs.length, 0, "no lock entry must be written for no-jh failure");
  } finally {
    cleanup(dir);
  }
});

test("install: legacy lockfile without commit field still restores", async () => {
  const dir = makeTempProject();
  try {
    const remote = makeFixtureRepo(dir, "remote-gamma");

    mkdirSync(join(dir, ".jaiph"), { recursive: true });
    writeFileSync(
      join(dir, ".jaiph", "libs.lock"),
      JSON.stringify({ libs: [{ name: "remote-gamma", url: remote }] }) + "\n",
      "utf8",
    );

    const code = await runInstall([], { cwd: dir });

    assert.equal(code, 0, "restore from legacy lockfile (no commit) must succeed");
    const libDir = join(dir, ".jaiph", "libs", "remote-gamma");
    assert.ok(existsSync(libDir), "lib dir should be present after restore");
    assert.ok(!existsSync(join(libDir, ".git")), ".git directory must still be stripped on restore");
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
      writeFileSync(join(spec.libDir, "lib.jh"), "", "utf8");
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
