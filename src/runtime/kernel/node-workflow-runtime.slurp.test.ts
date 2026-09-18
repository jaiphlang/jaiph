import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { buildScriptsFromGraph, loadModuleGraph } from "../../transpiler";

/**
 * Output-handle model (call result is a handle; `const`/`if`/`${}` slurp;
 * `stdin` streams). These tests pin the force/keep rules with real byte volumes:
 * a discarded statement and a `stdin` producer never materialize their bytes in
 * V8, while a `const` capture does.
 */

const MIB = 1024 * 1024;

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
    // Silence the idle-output warn cadence so it can't add noise to the run.
    JAIPH_STEP_IDLE_WARN_SEC: "0",
  };
  return new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
}

/** Run a workflow while polling RSS, returning the peak growth over the run. */
async function runWithRssWatch(
  runtime: NodeWorkflowRuntime,
  defName: string,
  args: string[],
): Promise<{ status: number; peakDeltaBytes: number }> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 3);
  timer.unref();
  try {
    const status = await runtime.runRoot(defName, args);
    return { status, peakDeltaBytes: peak - before };
  } finally {
    clearInterval(timer);
  }
}

// Warm up JIT + heap baseline through the streaming/spawn/build paths once, so
// the RSS deltas measured below reflect payload handling, not one-time process
// growth (the first workflow in a fresh process grows RSS ~tens of MiB).
before(async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-warm-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script warm = `head -c 4194304 /dev/zero | tr '\\0' a`",
        'script sink = `wc -c > /dev/null`',
        "export def main() {",
        "  const w = warm()",
        "  stdin warm() -> sink()",
        "}",
        "",
      ].join("\n"),
    );
    await runtime.runRoot("main", []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A 64 MiB producer emitted as a *statement* is discarded, so its bytes must
// stay on disk — peak extra RSS must not track the 64 MiB. Fails on the old
// `output += chunk` accumulation.
test("statement call does not slurp: 64 MiB discarded stays off the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-stmt-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script big = `head -c 67108864 /dev/zero | tr '\\0' a`",
        "export def main() {",
        "  big()",
        "}",
        "",
      ].join("\n"),
    );
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", []);
    assert.equal(status, 0, "the statement ran to completion");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `discarded 64 MiB must not track into RSS (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `const x = `echo hi`()` binds the string "hi" (slurped + trimmed). No read(),
// no E_VALIDATE, and it interpolates like any string.
test("const slurps a small call result to a trimmed string", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-const-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "export def main() {",
        "  const x = `echo hi`()",
        '  return "[${x}]"',
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    assert.equal(readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8"), "[hi]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The const slurp is real: `const x = big()` materializes N bytes as a JS
// string. Piping x into `wc -c` (x is now a plain string) reports N.
test("const slurp is a real string of the producer's full byte length", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-real-"));
  try {
    const n = 2 * MIB;
    const runtime = makeRuntime(
      root,
      [
        `script big = \`head -c ${n} /dev/zero | tr '\\0' a\``,
        "script count = `wc -c | tr -d ' \\n'`",
        "export def main() {",
        "  const x = big()",
        "  const len = stdin x -> count()",
        "  return len",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    // `const x = big()` gives a JS string; big() emits exactly n bytes (no
    // trailing newline), so the slurped string has length n.
    assert.equal(readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8"), String(n));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `stdin big() -> sink()` streams the producer's output handle into the child:
// the sink sees all N bytes, but peak extra RSS must not track them.
test("stdin producer does not slurp: 64 MiB streams to the sink off the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-stdin-"));
  try {
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      [
        `script big = \`head -c ${n} /dev/zero | tr '\\0' a\``,
        'script sink = `wc -c | tr -d " \\n" > "$1"`',
        "export def main(out) {",
        "  stdin big() -> sink(out)",
        "}",
        "",
      ].join("\n"),
    );
    const outPath = join(root, "count.txt");
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", [outPath]);
    assert.equal(status, 0);
    assert.equal(readFileSync(outPath, "utf8"), String(n), "sink received all N bytes via stdin");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `streamed 64 MiB must not track into RSS (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A 3-stage pipeline streams 64 MiB producer -> pass-through -> sink. The
// uncaptured result is discarded, so no stage holds its full body as a JS
// string, even though the intermediate stage tees its stdout to its `.out`
// capture (streamed to disk, never a string). The sink counts exactly N bytes;
// peak extra RSS must not track the payload through the extra pipe hop.
test("stdin big() -> pass() -> sink(): 64 MiB streams through an intermediate stage off the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-pipe3-"));
  try {
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      [
        `script big = \`head -c ${n} /dev/zero | tr '\\0' a\``,
        "script pass = `cat`",
        'script sink = `wc -c | tr -d " \\n" > "$1"`',
        "export def main(out) {",
        "  stdin big() -> pass() -> sink(out)",
        "}",
        "",
      ].join("\n"),
    );
    const outPath = join(root, "count.txt");
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", [outPath]);
    assert.equal(status, 0);
    assert.equal(readFileSync(outPath, "utf8"), String(n), "sink counted all N bytes through the pipeline");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `intermediate stage must stream, not slurp (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A def is a handle: `def wrap() { return big() }` propagates big's handle.
// `stdin wrap() -> sink()` streams it (no-slurp); the producer may be a def.
test("def return is an output handle: stdin wrap() -> sink() streams without slurping", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-defwrap-"));
  try {
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      [
        `script big = \`head -c ${n} /dev/zero | tr '\\0' a\``,
        'script sink = `wc -c | tr -d " \\n" > "$1"`',
        "def wrap() {",
        "  return big()",
        "}",
        "export def main(out) {",
        "  stdin wrap() -> sink(out)",
        "}",
        "",
      ].join("\n"),
    );
    const outPath = join(root, "count.txt");
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", [outPath]);
    assert.equal(status, 0);
    assert.equal(readFileSync(outPath, "utf8"), String(n), "sink received the def handle's N bytes via stdin");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `def-wrapped 64 MiB must stream, not slurp (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The opposite pin: `const y = wrap()` is a force site, so the same def handle
// IS slurped — RSS grows with the 64 MiB. (Allowed to be expensive.)
test("const y = wrap() forces the def handle: the bytes are slurped into a string", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-defconst-"));
  try {
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      [
        `script big = \`head -c ${n} /dev/zero | tr '\\0' a\``,
        "script count = `wc -c | tr -d ' \\n'`",
        "def wrap() {",
        "  return big()",
        "}",
        "export def main() {",
        "  const y = wrap()",
        "  const len = stdin y -> count()",
        "  return len",
        "}",
        "",
      ].join("\n"),
    );
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", []);
    assert.equal(status, 0);
    // `const y = wrap()` slurped the handle to a string; `wc -c` over that
    // string's bytes reports n. big() emits exactly n bytes (no newline), so
    // `const y` was NOT trimmed to empty — it holds the full payload.
    assert.equal(readFileSync(join(runtime.getRunDir(), "return_value.txt"), "utf8"), String(n));
    assert.ok(
      peakDeltaBytes > 48 * MIB,
      `const capture must slurp the 64 MiB (peak only +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `logerr "${failure}"` slurps the failed step's stdout CONTENTS, never a
// run-dir path — the binding is an output handle.
test("recover binding: ${failure} slurps failed stdout contents, not a .out path", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-recover-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script boom = ```",
        'echo "the-failure-stdout"',
        "exit 1",
        "```",
        'script record = `printf "%s" "$1" > seen.txt`',
        "export def main() {",
        "  boom() catch (failure) {",
        "    record(failure)",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const seen = readFileSync(join(root, "seen.txt"), "utf8");
    assert.equal(seen, "the-failure-stdout", "binding is the failed step's stdout contents");
    assert.doesNotMatch(seen, /\.jaiph\/runs\/.+\.out/, "binding must never be a run-dir capture path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The binding is the failed step's stdout THEN stderr, merged into one handle.
// A force site (argv) slurps the merged contents (trimmed); `stdin failure ->`
// streams the merged capture verbatim.
test("recover binding: handle is merged stdout then stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-recover-merge-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script boom = ```",
        'echo "out-line"',
        'echo "err-line" >&2',
        "exit 1",
        "```",
        'script record = `printf "%s" "$1" > seen.txt`',
        'script save = `cat > streamed.txt`',
        "export def main() {",
        "  boom() catch (failure) {",
        "    stdin failure -> save()",
        "    record(failure)",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const seen = readFileSync(join(root, "seen.txt"), "utf8");
    assert.equal(seen, "out-line\nerr-line", "argv force slurps merged stdout+stderr (trimmed)");
    assert.doesNotMatch(seen, /\.jaiph\/runs\/.+\.out/, "binding must never be a run-dir capture path");
    const streamed = readFileSync(join(root, "streamed.txt"), "utf8");
    assert.equal(streamed, "out-line\nerr-line\n", "stdin streams the merged capture verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A Unix failure that writes only to stderr still yields a non-empty handle,
// trimmed the same way a stdout handle is — no `2>&1` required on the producer.
test("recover binding: stderr-only failure yields the stderr text", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-slurp-recover-stderr-"));
  try {
    const runtime = makeRuntime(
      root,
      [
        "script boom = ```",
        'echo "boom" >&2',
        "exit 1",
        "```",
        'script record = `printf "%s" "$1" > seen.txt`',
        "export def main() {",
        "  boom() catch (failure) {",
        "    record(failure)",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const seen = readFileSync(join(root, "seen.txt"), "utf8");
    assert.equal(seen, "boom", "binding is the stderr text when stdout is empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
