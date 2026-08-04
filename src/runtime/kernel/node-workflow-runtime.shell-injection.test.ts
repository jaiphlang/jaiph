import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { loadModuleGraph } from "../../transpiler";
import { buildScriptsFromGraph } from "../../transpiler";

// Security regression for finding H-1: caller-controlled workflow values must
// never be spliced unescaped into a `sh -c` shell-fallthrough body. Every value
// the runtime interpolates into a shell line is passed through `shellQuote`
// first, so a `$(…)` command substitution or a `; …` metacharacter breakout in
// a parameter / capture value cannot execute.
//
// `runRoot(ref, positionalArgs)` binds args to the workflow's params by
// position — the exact same positional binding that `jaiph mcp` / `jaiph serve`
// perform: `spec.params.map((p) => args[p] ?? "")` (see src/cli/commands/mcp.ts
// and src/cli/commands/serve.ts) produces a positional array that reaches the
// runner as `runRoot(name, args)`. Driving `runRoot` with a hostile positional
// value therefore exercises the mcp/serve `args[p]` path into a shell body.

function makeRuntime(root: string, jh: string): NodeWorkflowRuntime {
  const moduleGraph = loadModuleGraph(jh);
  // Emit `scripts/` so the `emit_danger` script def is executable at runtime.
  const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
  const graph = buildRuntimeGraph(moduleGraph);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_TEST_MODE: "1",
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    JAIPH_SCRIPTS: scriptsDir,
    // Shell-fallthrough lines run with cwd = JAIPH_WORKSPACE, so relative
    // redirects below land deterministically in `root`.
    JAIPH_WORKSPACE: root,
  };
  return new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
}

const TOOLS = [
  // Quoted shell body — the flagship AC example.
  "workflow greet(name) {",
  '  echo "Hello ${name}" > greeting.txt',
  "}",
  "",
  // Unquoted shell body — where a `;`/`#` payload could actually break out of
  // word boundaries if the value were not escaped.
  "workflow greet_bare(name) {",
  "  echo Hello ${name} > greeting_bare.txt",
  "}",
  "",
  // Inline `${run …}` capture spliced into a shell body: the captured value is
  // also caller-influenced and must be shell-quoted (the old warn-only guard
  // inspected prompt captures only and missed this provenance).
  "script emit_danger = `printf '$(id)'`",
  "workflow cap() {",
  '  echo "captured ${run emit_danger()}" > cap.txt',
  "}",
  "",
].join("\n");

function setup(prefix: string): { root: string; jh: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, TOOLS);
  return { root, jh };
}

// AC1: `greet(name)` invoked with `name = "$(id)"` does not execute the command
// substitution — the `$(id)` text survives literally (escaped), `id` never runs.
test("shell injection: command substitution in a param does not execute", async () => {
  const { root, jh } = setup("jaiph-shinj-cmdsub-");
  try {
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("greet", ["$(id)"]);
    assert.equal(status, 0, "workflow ran to completion");
    const out = readFileSync(join(root, "greeting.txt"), "utf8");
    assert.doesNotMatch(out, /uid=/, "`id` output must not appear — command substitution did not run");
    assert.equal(out, "Hello $\\(id\\)\n", "the $(id) text is emitted literally (shell-quoted), not evaluated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC2: a `$(touch …)` command substitution inside the quoted body creates no
// file — the substitution is neutralised even inside double quotes (where
// `$(…)` would otherwise still expand).
test("shell injection: $(touch) in a param creates no file (quoted body)", async () => {
  const { root, jh } = setup("jaiph-shinj-touch-");
  try {
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("greet", ["$(touch pwned.txt)"]);
    assert.equal(status, 0);
    assert.ok(!existsSync(join(root, "pwned.txt")), "no file created — $(touch) did not execute");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC2 (exact payload from the task) plus an unquoted body, where `;` could
// otherwise terminate the `echo` and start a new `touch` command.
test("shell injection: '; touch … #' in a param creates no file (unquoted body)", async () => {
  const { root, jh } = setup("jaiph-shinj-metachar-");
  try {
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("greet_bare", ["; touch pwned_bare.txt #"]);
    assert.equal(status, 0);
    assert.ok(!existsSync(join(root, "pwned_bare.txt")), "no file created — metacharacters did not break out");
    const out = readFileSync(join(root, "greeting_bare.txt"), "utf8");
    assert.equal(out, "Hello ; touch pwned_bare.txt #\n", "the payload is echoed literally");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The `capture` provenance the old prompt-only guard missed: an inline
// `${run …}` result carrying `$(id)` is shell-quoted before it re-enters sh.
test("shell injection: an inline capture value is shell-quoted, not re-evaluated", async () => {
  const { root, jh } = setup("jaiph-shinj-capture-");
  try {
    const runtime = makeRuntime(root, jh);
    const status = await runtime.runRoot("cap", []);
    assert.equal(status, 0);
    const out = readFileSync(join(root, "cap.txt"), "utf8");
    assert.doesNotMatch(out, /uid=/, "captured $(id) must not execute in the outer shell line");
    assert.equal(out, "captured $\\(id\\)\n", "the captured $(id) is emitted literally (shell-quoted)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
