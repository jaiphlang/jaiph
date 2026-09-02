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
async function runReturn(
  lines: string[],
  args: string[] = [],
): Promise<{ status: number; value?: string; root: string }> {
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
  const status = await runtime.runMain(args);
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

test("nested const templates interpolate enclosing params/consts (quoted and triple-quoted)", async () => {
  const { status, value, root } = await runReturn(
    [
      "export def main(who) {",
      '  const greeting = "hello ${who}"',
      '  const note = """',
      "    note for ${who}",
      '  """',
      "  def helper(name) {",
      '    const msg = "${greeting}-${name}"',
      "    return msg",
      "  }",
      '  const h = run helper("bob")',
      '  return "${h}|${note}"',
      "}",
    ],
    ["world"],
  );
  try {
    assert.equal(status, 0);
    assert.equal(value, "hello world-bob|note for world");
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

// -- Block-scoped in-branch declarations (runtime) --------------------------
// The taken branch executes its nested decl; an enclosing/module name shadowed
// inside a branch is restored after it.

test("nested script inside a taken `if` body runs and its return is the def result", async () => {
  const { status, value, root } = await runReturn(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "    return run s()",
      "  }",
      '  return "none"',
      "}",
    ],
    ["y"],
  );
  try {
    assert.equal(status, 0);
    assert.equal(value, "YES");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested script inside the taken `else` body runs and its return is the def result", async () => {
  const { status, value, root } = await runReturn(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "    return run s()",
      "  } else {",
      "    script t = `echo NO`",
      "    return run t()",
      "  }",
      "}",
    ],
    ["n"],
  );
  try {
    assert.equal(status, 0);
    assert.equal(value, "NO");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a `for` body nested script receives the iterator via argv and runs once per line", async () => {
  const { status, value, root } = await runReturn(
    [
      "export def main(src) {",
      "  script show = `cat trace.txt`",
      "  for line in src {",
      '    script emit = `printf "[%s]" "$1" >> trace.txt`',
      "    run emit(line)",
      "  }",
      "  return run show()",
      "}",
    ],
    ["a\nb\nc"],
  );
  try {
    assert.equal(status, 0);
    // The `for`-body nested script `emit` ran once per line, each with the
    // iterator passed as argv ($1); `show` reads back the accumulated trace.
    assert.equal(value, "[a][b][c]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested script inside a `catch` body runs on failure and its return is the catch result", async () => {
  const { status, value, root } = await runReturn([
    "export def main() {",
    "  script boom = `exit 3`",
    "  run boom() catch (e) {",
    "    script s = `echo recovered`",
    "    return run s()",
    "  }",
    '  return "x"',
    "}",
  ]);
  try {
    assert.equal(status, 0);
    assert.equal(value, "recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a script shadowed inside a taken `if` does not leak; the enclosing script runs after", async () => {
  const { status, value, root } = await runReturn(
    [
      "script s = `printf OUTER`",
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `printf INNER`",
      "    const inner = run s()",
      '    log "${inner}"',
      "  }",
      "  return run s()",
      "}",
    ],
    ["y"],
  );
  try {
    assert.equal(status, 0);
    // The inner `s` ran inside the branch, but after the `if` the module `s` is restored.
    assert.equal(value, "OUTER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Nested-def self-recursion (runtime) ------------------------------------
// A nested `def` may call itself; a base case terminates and returns the
// computed value, while a runaway self-recursion hits the existing depth cap.

test("a nested def with a base case recurses on itself and returns the computed value", async () => {
  const { status, value, root } = await runReturn([
    "export def main() {",
    "  def countdown(n) {",
    '    if n == "0" {',
    '      return "done"',
    "    }",
    '    script dec = `echo $(( $1 - 1 ))`',
    "    const m = run dec(n)",
    "    return run countdown(m)",
    "  }",
    '  return run countdown("3")',
    "}",
  ]);
  try {
    // Self-recursion runs three levels deep, then the base case returns "done".
    assert.equal(status, 0);
    assert.equal(value, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runaway nested self-recursion hits the recursion-depth cap, not an unknown-local failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-recur-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        "export def main() {",
        "  def loop(n) {",
        "    return run loop(n)",
        "  }",
        '  return run loop("1")',
        "}",
        "",
      ].join("\n"),
    );
    // Compiles fine (self-recursion validates), then diverges at runtime.
    buildScripts(jh, join(root, "out"));
    const graph = buildRuntimeGraph(jh);
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_WORKSPACE: root,
      },
      cwd: root,
      suppressLiveEvents: true,
    });
    const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
    process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
    let status: number;
    let summary: string;
    try {
      status = await runtime.runMain([]);
      summary = readFileSync(runtime.getSummaryFile(), "utf8");
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
    }
    assert.notEqual(status, 0, "runaway recursion must fail");
    // The failure is the depth cap, NOT the pre-fix "unknown local" miss.
    assert.match(summary, /Maximum recursion depth \(256\) exceeded/);
    assert.doesNotMatch(summary, /unknown local/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested named prompt interpolates an enclosing param and a triple-quoted body", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-prompt-param-"));
  try {
    const jh = join(root, "flow.jh");
    writeFileSync(
      jh,
      [
        "export def main(who) {",
        '  prompt describe(x) = "Tell ${who} about ${x}"',
        "  prompt describe_block(x) = \"\"\"",
        "    Block ${who} ${x}",
        "  \"\"\"",
        '  const r = prompt describe("today")',
        '  const b = prompt describe_block("now")',
        '  return "${r}|${b}"',
        "}",
        "",
      ].join("\n"),
    );
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
    const status = await runtime.runMain(["Ada"]);
    assert.equal(status, 0);
    const rv = readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8");
    assert.match(rv, /Tell Ada about today/);
    assert.match(rv, /Block Ada now/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
