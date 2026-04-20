import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "./init";
import { parsejaiph } from "../../parser";

const CANONICAL_GITIGNORE = "runs\ntmp\n";

function makeTempDir(): string {
  const dir = join(tmpdir(), `jaiph-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("init: creates .jaiph/.gitignore with runs and tmp", () => {
  const dir = makeTempDir();
  try {
    assert.equal(runInit([dir]), 0);
    const gi = join(dir, ".jaiph", ".gitignore");
    assert.equal(existsSync(gi), true);
    assert.equal(readFileSync(gi, "utf8"), CANONICAL_GITIGNORE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: second run succeeds when .gitignore matches template", () => {
  const dir = makeTempDir();
  try {
    assert.equal(runInit([dir]), 0);
    assert.equal(runInit([dir]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: generated bootstrap uses triple-quoted prompt and parses", () => {
  const dir = makeTempDir();
  try {
    assert.equal(runInit([dir]), 0);
    const bootstrapPath = join(dir, ".jaiph", "bootstrap.jh");
    const source = readFileSync(bootstrapPath, "utf8");
    assert.equal(source.includes('prompt """'), true);
    assert.doesNotThrow(() => parsejaiph(source, bootstrapPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: does not create .jaiph/Dockerfile", () => {
  const dir = makeTempDir();
  try {
    assert.equal(runInit([dir]), 0);
    assert.equal(existsSync(join(dir, ".jaiph", "Dockerfile")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: fails when .jaiph/.gitignore exists with unexpected content", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, ".jaiph"), { recursive: true });
    writeFileSync(join(dir, ".jaiph", ".gitignore"), "custom\n", "utf8");
    assert.equal(runInit([dir]), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: fails when .jaiph/bootstrap.jh exists with unexpected content", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, ".jaiph"), { recursive: true });
    writeFileSync(join(dir, ".jaiph", ".gitignore"), CANONICAL_GITIGNORE, "utf8");
    writeFileSync(join(dir, ".jaiph", "bootstrap.jh"), "# not the template\n", "utf8");
    assert.equal(runInit([dir]), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
