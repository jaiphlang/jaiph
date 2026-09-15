import test from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime, _scriptSpawn } from "./node-workflow-runtime";
import { buildScriptsFromGraph, loadModuleGraph } from "../../transpiler";

/**
 * Spy on `_scriptSpawn.spawn` while still delegating to the real spawn (so `cat`
 * actually reads stdin), recording each call's (command, args) for argv checks.
 */
async function withSpawnSpy(
  fn: (calls: Array<{ command: string; args: string[] }>) => Promise<void>,
): Promise<void> {
  const calls: Array<{ command: string; args: string[] }> = [];
  const orig = _scriptSpawn.spawn;
  _scriptSpawn.spawn = ((command: string, args: string[], opts: unknown) => {
    calls.push({ command, args: [...args] });
    return realSpawn(command, args as readonly string[], opts as never);
  }) as typeof _scriptSpawn.spawn;
  try {
    await fn(calls);
  } finally {
    _scriptSpawn.spawn = orig;
  }
}

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
  };
  return new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
}

// AC: `run echo_stdin() stdin payload` with `script echo_stdin = `cat`` delivers
// the payload on the child's stdin (cat echoes it to stdout), and the payload
// never appears in the spawn argv.
test("run script() stdin payload: payload arrives on stdin, not argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-echo-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script echo_stdin = `cat`",
        "export def main(payload) {",
        "  run echo_stdin() stdin payload",
        "}",
        "",
      ].join("\n"),
    );
    await withSpawnSpy(async (calls) => {
      const status = await runtime.runRoot("main", ["secret-payload"]);
      assert.equal(status, 0, "workflow ran to completion");

      // Payload must not be in any spawn argv — it travels on stdin only.
      for (const c of calls) {
        assert.ok(
          !c.args.some((a) => a.includes("secret-payload")),
          `payload must not appear in argv: ${JSON.stringify(c.args)}`,
        );
      }

      // The echo_stdin step's stdout capture equals the payload (cat echoed it).
      const runDir = runtime.getRunDir();
      const outFile = readdirSync(runDir).find((f) => f.endsWith(".out") && f.includes("echo_stdin"));
      assert.ok(outFile, "expected an echo_stdin .out capture");
      assert.equal(readFileSync(join(runDir, outFile!), "utf8"), "secret-payload");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: a stdin payload larger than 1 MB (which argv/ARG_MAX could not carry) is
// written to the child in full, and the step exits 0.
test("run script() stdin: a payload > 1 MB is written in full and the step exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-big-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        'script save = `cat > "$1"`',
        "export def main(path, payload) {",
        "  run save(path) stdin payload",
        "}",
        "",
      ].join("\n"),
    );
    const big = "x".repeat(1_200_000); // 1.2 MB — beyond a typical ARG_MAX
    const outPath = join(root, "big.out");
    const status = await runtime.runRoot("main", [outPath, big]);
    assert.equal(status, 0, "step exits 0 with an oversized stdin payload");
    const written = readFileSync(outPath, "utf8");
    assert.equal(written.length, big.length, "the full payload was written");
    assert.equal(written, big, "the payload bytes are verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: an inline-script run also pipes stdin.
test("run `cat`() stdin payload: inline script receives stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-inline-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "export def main(payload) {",
        "  run `cat`() stdin payload",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", ["inline-body"]);
    assert.equal(status, 0);
    const runDir = runtime.getRunDir();
    const outFile = readdirSync(runDir).find((f) => f.endsWith(".out") && f.includes("inline"));
    assert.ok(outFile, "expected an inline-script .out capture");
    assert.equal(readFileSync(join(runDir, outFile!), "utf8"), "inline-body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
