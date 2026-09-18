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

// AC: `echo_stdin() stdin payload` with `script echo_stdin = `cat`` delivers
// the payload on the child's stdin (cat echoes it to stdout), and the payload
// never appears in the spawn argv.
test("script() stdin payload: payload arrives on stdin, not argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-echo-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script echo_stdin = `cat`",
        "export def main(payload) {",
        "  stdin payload -> echo_stdin()",
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
test("script() stdin: a payload > 1 MB is written in full and the step exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-big-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        'script save = `cat > "$1"`',
        "export def main(path, payload) {",
        "  stdin payload -> save(path)",
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

/** Read the run's return_value.txt (written on a successful returning def). */
function returnValue(runtime: NodeWorkflowRuntime): string {
  return readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8");
}

// AC: foo writes `a\nb\n`, bar uppercases, baz counts the uppercase lines. The
// user-visible result of `stdin foo() -> bar() -> baz()` is 2, and each stage
// is its own progress step. `baz` counts only UPPERCASE-leading lines so that
// dropping or swapping a stage changes the number and fails the assertion.
const PIPE_MODULE = [
  "script foo = ```bash",
  "printf 'a\\nb\\n'",
  "```",
  "script bar = ```bash",
  "tr 'a-z' 'A-Z'",
  "```",
  "script baz = ```bash",
  "grep -c '^[A-Z]' || true",
  "```",
].join("\n");

test("stdin foo() -> bar() -> baz(): three-stage pipeline reduces to 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-pipe-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        PIPE_MODULE,
        "export def main() {",
        "  const n = stdin foo() -> bar() -> baz()",
        "  return n",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0, "pipeline ran to completion");
    assert.equal(returnValue(runtime), "2", "last stage reduces to the line count");

    // The middle stage ran on the producer's output (uppercased a\nb → A\nB).
    const runDir = runtime.getRunDir();
    const barOut = readdirSync(runDir).find((f) => f.endsWith(".out") && f.includes("bar"));
    assert.ok(barOut, "expected a bar .out capture");
    assert.equal(readFileSync(join(runDir, barOut!), "utf8"), "A\nB\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdin foo() -> baz(): dropping the uppercase stage changes the result (not 2)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-pipe-drop-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        PIPE_MODULE,
        "export def main() {",
        "  const n = stdin foo() -> baz()",
        "  return n",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    assert.equal(returnValue(runtime), "0", "no uppercase lines when bar is dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdin wrap() -> bar(): a def producer feeds the same bytes as the script producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-wrap-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        PIPE_MODULE,
        "def wrap() {",
        "  return foo()",
        "}",
        "export def main() {",
        "  stdin wrap() -> bar()",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const runDir = runtime.getRunDir();
    const barOut = readdirSync(runDir).find((f) => f.endsWith(".out") && f.includes("bar"));
    assert.ok(barOut, "expected a bar .out capture");
    assert.equal(readFileSync(join(runDir, barOut!), "utf8"), "A\nB\n", "wrap() -> bar() == foo() -> bar()");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: catch on a pipeline is a one-shot handler. A non-zero intermediate stage
// stops the pipeline; the attached catch runs once and the def succeeds.
test("stdin gen() -> boom() -> sink() catch: a failing middle stage runs the one-shot catch", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-catch-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script gen = ```bash",
        "echo hi",
        "```",
        "script boom = ```bash",
        "exit 3",
        "```",
        "script sink = ```bash",
        "cat",
        "```",
        "export def main() {",
        "  stdin gen() -> boom() -> sink() catch (e) {",
        '    log "recovered"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0, "catch handled the middle-stage failure");
    // sink never ran (later stages do not start after the first non-zero stage).
    const runDir = runtime.getRunDir();
    const sinkOut = readdirSync(runDir).find((f) => f.endsWith(".out") && f.includes("sink"));
    assert.equal(sinkOut, undefined, "sink stage did not start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: an inline-script run also pipes stdin.
test("`cat`() stdin payload: inline script receives stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-stdin-inline-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "export def main(payload) {",
        "  stdin payload -> `cat`()",
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
