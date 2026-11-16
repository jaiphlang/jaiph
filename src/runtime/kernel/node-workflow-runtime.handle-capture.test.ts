import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { buildScriptsFromGraph, loadModuleGraph } from "../../transpiler";

/**
 * Async handles are stored out of band (a per-scope `handles` map), never as a
 * magic-prefixed string in `scope.vars`. So a captured script string that reads
 * exactly like a handle id (`__JAIPH_HANDLE__1`) is a literal, not a swap into
 * another step's result — the regression this pins.
 */

function makeRuntime(root: string, jhBody: string): NodeWorkflowRuntime {
  const jh = join(root, "flow.jh");
  writeFileSync(jh, jhBody);
  const moduleGraph = loadModuleGraph(jh);
  const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
  const graph = buildRuntimeGraph(moduleGraph);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_TEST_MODE: "1",
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    JAIPH_SCRIPTS: scriptsDir,
    JAIPH_WORKSPACE: root,
    JAIPH_STEP_IDLE_WARN_SEC: "0",
  };
  return new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
}

// AC: a script prints `__JAIPH_HANDLE__1` while async handle 1 exists; the
// captured variable interpolates to the LITERAL text, not handle 1's result.
// The first (and only) handle this runtime mints is `async slow()` → id
// `__JAIPH_HANDLE__1`, so a prefix-based detector would resolve `${x}` to
// "slowdone". Out-of-band storage keeps `${x}` the captured literal.
test("captured string that reads like a handle id stays a literal", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-capture-"));
  try {
    const outPath = join(root, "captured.txt");
    const jh = [
      "script slow = '''",
      "sleep 0.2",
      "printf '%s' slowdone",
      "'''",
      "script emit = '''",
      "printf '%s' __JAIPH_HANDLE__1",
      "'''",
      "script sink = '''",
      `printf '%s' "$1" > ${outPath}`,
      "'''",
      "export def main() {",
      "  async slow()",
      "  const x = emit()",
      '  sink("${x}")',
      "}",
      "",
    ].join("\n");
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const captured = readFileSync(outPath, "utf8");
    assert.equal(
      captured,
      "__JAIPH_HANDLE__1",
      "captured string must stay a literal, never resolve to async handle 1's result",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
