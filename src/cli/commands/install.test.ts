import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { parseUrlAndVersion } from "./install";

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
