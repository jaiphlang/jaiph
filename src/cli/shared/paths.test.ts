import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectWorkspaceRoot } from "./paths";

test("detectWorkspaceRoot: isolated temp dir without markers resolves to that directory", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-detect-root-iso-"));
  try {
    assert.equal(detectWorkspaceRoot(root), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "detectWorkspaceRoot: under repo .jaiph/tmp sandbox does not jump to outer repo",
  { skip: !existsSync(join(process.cwd(), ".jaiph", "tmp")) },
  () => {
    const repoRoot = process.cwd();
    const jaiphTmp = join(repoRoot, ".jaiph", "tmp");
    const sandbox = mkdtempSync(join(jaiphTmp, "jaiph-detect-root-sbx-"));
    try {
      assert.equal(detectWorkspaceRoot(sandbox), resolve(sandbox));
      assert.notEqual(resolve(sandbox), resolve(repoRoot));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test(
  "detectWorkspaceRoot: normal path inside repo resolves to repository root",
  { skip: !existsSync(join(process.cwd(), ".git")) },
  () => {
    const repoRoot = process.cwd();
    const sub = join(repoRoot, "src");
    assert.equal(detectWorkspaceRoot(sub), resolve(repoRoot));
  },
);

test("detectWorkspaceRoot: .jaiph config dir does not become workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-detect-root-jaiph-dir-"));
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".jaiph", ".jaiph"), { recursive: true });
    assert.equal(detectWorkspaceRoot(join(root, ".jaiph")), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
