import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

// Resolve workspace.sh relative to the project root (not dist/).
// __dirname may be src/... or dist/src/...; walk up until we find package.json.
function findProjectRoot(): string {
  let dir = __dirname;
  while (dir !== "/") {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("cannot find project root");
}
const WORKSPACE_SH = join(findProjectRoot(), ".jaiph/libs/jaiphlang/workspace.sh");

function gitInit(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git add -A && git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// workspace.sh: export_patch
// ---------------------------------------------------------------------------

test("workspace.sh export_patch: creates patch at JAIPH_RUN_DIR/<name> and returns path", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-export-patch-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    gitInit(root);

    // Create a tracked change
    writeFileSync(join(root, "file.txt"), "hello\n");

    const out = execSync(`bash "${WORKSPACE_SH}" export_patch candidate.patch`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    const expectedPath = join(runDir, "candidate.patch");
    assert.equal(out, expectedPath, "return value should be the absolute path");
    assert.ok(existsSync(expectedPath), "patch file should exist");

    const patchContent = readFileSync(expectedPath, "utf8");
    assert.ok(patchContent.includes("file.txt"), "patch should reference the changed file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.sh export_patch: excludes .jaiph/ from the produced patch", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-export-excl-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    gitInit(root);

    // Create files: one under .jaiph/, one outside
    mkdirSync(join(root, ".jaiph"), { recursive: true });
    writeFileSync(join(root, ".jaiph", "artifact.txt"), "should-be-excluded\n");
    writeFileSync(join(root, "code.txt"), "should-be-included\n");

    execSync(`bash "${WORKSPACE_SH}" export_patch test.patch`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    const patchContent = readFileSync(join(runDir, "test.patch"), "utf8");
    assert.ok(patchContent.includes("code.txt"), "patch should include code.txt");
    assert.ok(!patchContent.includes(".jaiph/artifact.txt"), "patch must not include .jaiph/ files");
    assert.ok(!patchContent.includes("should-be-excluded"), "patch must not contain .jaiph/ content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workspace.sh: export
// ---------------------------------------------------------------------------

test("workspace.sh export: copies file to JAIPH_RUN_DIR/<name> and returns path", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-export-file-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(root, "report.json"), '{"status":"ok"}\n');

    const out = execSync(`bash "${WORKSPACE_SH}" export report.json output.json`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    const expectedPath = join(runDir, "output.json");
    assert.equal(out, expectedPath, "return value should be the absolute path");
    assert.ok(existsSync(expectedPath), "exported file should exist");
    assert.equal(readFileSync(expectedPath, "utf8"), '{"status":"ok"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workspace.sh: apply_patch
// ---------------------------------------------------------------------------

test("workspace.sh apply_patch: applies a valid patch to the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-apply-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });

    // Create a tracked file then modify it
    gitInit(root);
    writeFileSync(join(root, "tracked.txt"), "original\n");
    execSync("git add tracked.txt && git commit -m 'add tracked'", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "tracked.txt"), "modified\n");

    execSync(`bash "${WORKSPACE_SH}" export_patch apply_test.patch`, {
      cwd: root,
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    // Reset workspace back to committed state
    execSync("git checkout -- .", { cwd: root, stdio: "ignore" });
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "original\n");

    // Apply the patch
    execSync(`bash "${WORKSPACE_SH}" apply_patch "${join(runDir, "apply_test.patch")}"`, {
      cwd: root,
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "modified\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.sh apply_patch: fails when patch cannot be applied cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-apply-fail-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    gitInit(root);

    // Create a file, commit, then create a change and export patch
    writeFileSync(join(root, "conflict.txt"), "original\n");
    execSync("git add -A && git commit -m 'add conflict.txt'", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "conflict.txt"), "changed-by-branch\n");
    execSync(`bash "${WORKSPACE_SH}" export_patch bad.patch`, {
      cwd: root,
      env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
    });

    // Reset and create a conflicting change
    execSync("git checkout -- .", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "conflict.txt"), "conflicting-coordinator-change\n");
    execSync("git add -A && git commit -m 'conflicting change'", { cwd: root, stdio: "ignore" });

    // Apply should fail
    assert.throws(
      () => {
        execSync(`bash "${WORKSPACE_SH}" apply_patch "${join(runDir, "bad.patch")}"`, {
          cwd: root,
          env: { ...process.env, JAIPH_WORKSPACE: root, JAIPH_RUN_DIR: runDir },
          stdio: "pipe",
        });
      },
      /./,
      "apply_patch should fail on conflicting patch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runtime: branch handle return values are plain user values
// ---------------------------------------------------------------------------

test("handle: branch return value is the user-defined return (no magic struct)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-handle-ret-"));
  try {
    const jh = join(root, "test.jh");
    writeFileSync(
      jh,
      `
workflow produce() {
  return "user-value-42"
}

workflow consume(val) {
  log "$val"
}

workflow default() {
  const h = run async produce()
  run consume("$h")
}
`,
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: non-exporting branch returns its function return value as-is", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ws-handle-plain-"));
  try {
    const jh = join(root, "test.jh");
    writeFileSync(
      jh,
      `
workflow compute() {
  return "plain-result"
}

workflow default() {
  const h = run async compute()
  log "\${h}"
  return "\${h}"
}
`,
    );
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const graph = buildRuntimeGraph(jh);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAIPH_TEST_MODE: "1",
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
    };
    const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root });
    const result = await runtime.runNamedWorkflow("default", []);
    assert.equal(result.status, 0);
    assert.equal(result.returnValue, "plain-result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
