// Nested-declaration runtime behaviour:
//  - a nested `def` is interpreted in-process and closes over the enclosing
//    def's `const`s / params (lexical scope);
//  - a nested `script` runs as a sterile subprocess: it does not see the
//    enclosing binding unless it is passed as argv (`$1`);
//  - a nested `script foo` shadows a module-level `script foo` (the nested body
//    runs);
//  - a nested named `prompt` interpolates the enclosing scope at invocation.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScripts } from "../../transpiler";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

/** Emit scripts, run `main`, and return the workflow's return value (or undefined). */
async function runReturn(lines: string[]): Promise<{ status: number; value?: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-rt-"));
  const jh = join(root, "flow.jh");
  writeFileSync(jh, `${lines.join("\n")}\n`);
  const { scriptsDir } = buildScripts(jh, join(root, "out"));
  const graph = buildRuntimeGraph(jh);
  const runtime = new NodeWorkflowRuntime(graph, {
    env: {
      ...process.env,
      JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
      JAIPH_SCRIPTS: scriptsDir,
      JAIPH_WORKSPACE: root,
    },
    cwd: root,
    suppressLiveEvents: true,
  });
  const status = await runtime.runMain([]);
  const rv = join(runtime.getRunDir(), "return_value.txt");
  return { status, value: existsSync(rv) ? readFileSync(rv, "utf8") : undefined, root };
}

test("a nested def interpolates an enclosing const/param without it being passed as an argument", async () => {
  const { status, value, root } = await runReturn([
    "export def main() {",
    '  const g = "hi"',
    "  def helper(name) {",
    '    return "helped-${g}-${name}"',
    "  }",
    '  return run helper("bob")',
    "}",
  ]);
  try {
    assert.equal(status, 0);
    // `g` was never passed to helper(); the nested def closes over it lexically.
    assert.equal(value, "helped-hi-bob");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested script does not see the enclosing binding unless passed as argv", async () => {
  const { status, value, root } = await runReturn([
    "export def main() {",
    '  const secret = "TOPSECRET"',
    "  script probe = `printf \"argv=[${1:-}] env=[${secret:-UNSET}]\"`",
    "  const noarg = run probe()",
    "  const witharg = run probe(secret)",
    '  return "${noarg}||${witharg}"',
    "}",
  ]);
  try {
    assert.equal(status, 0);
    assert.ok(value !== undefined);
    const [noarg, witharg] = value!.split("||");
    // Without an argv pass the script sees neither the value in $1 nor in the env.
    assert.equal(noarg, "argv=[] env=[UNSET]");
    // With an explicit argv pass the value arrives as $1; the env stays sterile.
    assert.equal(witharg, "argv=[TOPSECRET] env=[UNSET]");
    assert.ok(!noarg.includes("TOPSECRET"), "the enclosing const must not leak into the child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested `script foo` shadows a module-level `script foo` (the nested body runs)", async () => {
  const { status, value, root } = await runReturn([
    "script foo = `printf MODULE`",
    "export def main() {",
    "  script foo = `printf NESTED`",
    "  return run foo()",
    "}",
  ]);
  try {
    assert.equal(status, 0);
    assert.equal(value, "NESTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested named prompt interpolates the enclosing scope at invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-prompt-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        '  const topic = "weather"',
        '  prompt describe(x) = "Tell me about ${topic} for ${x}"',
        '  const r = prompt describe("today")',
        "  return r",
        "}",
        "",
      ].join("\n"),
    );
    // Echo agent: prints back the prompt text piped on stdin.
    const agent = join(root, "echo-agent");
    writeFileSync(agent, "#!/usr/bin/env bash\ncat\n", { mode: 0o755 });
    const graph = buildRuntimeGraph(jh);
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
      },
      cwd: root,
      suppressLiveEvents: true,
    });
    const status = await runtime.runMain([]);
    assert.equal(status, 0);
    const rv = readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8");
    // Enclosing const `topic` and own param `x` both interpolate.
    assert.match(rv, /Tell me about weather for today/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
