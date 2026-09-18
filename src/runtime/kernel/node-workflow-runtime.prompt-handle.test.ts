import test, { before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { buildScriptsFromGraph, loadModuleGraph } from "../../transpiler";

/**
 * `prompt x` / `prompt ${x}` (identifier / bare-ref body) keeps an output handle
 * as a handle: the transport streams the handle's on-disk bytes into the agent
 * backend rather than slurping the file into a JS string. Same keep-as-handle
 * rule as `stdin <handle> -> script()`. An interpolated `prompt "… ${x} …"`
 * still forces (the author asked to build a string). These tests pin both with
 * real byte volumes and by capturing exactly what body the backend received.
 */

const MIB = 1024 * 1024;

/**
 * A custom agent backend (command name is not `cursor-agent`, so the prompt is
 * piped via stdin) that copies its stdin verbatim to `capturePath` and prints a
 * short final answer. Reading the prompt from stdin lets a test assert exactly
 * what body the transport delivered. Returns the `JAIPH_AGENT_COMMAND` string.
 */
function writeCaptureBackend(root: string, capturePath: string): string {
  const backend = join(root, "capture-agent");
  writeFileSync(backend, ["#!/bin/sh", 'cat > "$1"', "echo ok", ""].join("\n"));
  chmodSync(backend, 0o755);
  return `${backend} ${capturePath}`;
}

function makeRuntime(root: string, jhBody: string, agentCommand: string): NodeWorkflowRuntime {
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
    // Custom (stdin) agent backend so the prompt body is delivered on stdin.
    JAIPH_AGENT_BACKEND: "cursor",
    JAIPH_AGENT_COMMAND: agentCommand,
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

// A def body that fails with a chosen stdout payload, then feeds the caught
// failure handle as the prompt body via `promptBody` (either `prompt failure`
// or `prompt ${failure}` or an interpolated wrapper).
function catchPromptFlow(payloadScript: string[], promptBody: string): string {
  return [
    "script boom = ```",
    ...payloadScript,
    "```",
    "export def main() {",
    "  boom() catch (failure) {",
    `    ${promptBody}`,
    "  }",
    "}",
    "",
  ].join("\n");
}

// Warm up JIT + heap baseline through the streaming/spawn paths once, so the RSS
// deltas below reflect payload handling, not one-time process growth.
before(async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-handle-warm-"));
  try {
    const capture = join(root, "warm.out");
    const cmd = writeCaptureBackend(root, capture);
    const runtime = makeRuntime(
      root,
      catchPromptFlow(["head -c 4194304 /dev/zero | tr '\\0' a", "exit 1"], "prompt failure"),
      cmd,
    );
    await runtime.runRoot("main", []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: `prompt x` with `x` a 64 MiB handle — the backend receives the CONTENTS
// (all N bytes), and jaiph peak extra RSS does not track N (same no-slurp bound
// as the stdin pins). Fails if the runtime slurps the handle into a JS string.
test("prompt failure: 64 MiB handle streams to the backend off the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-handle-big-"));
  try {
    const capture = join(root, "delivered.bin");
    const cmd = writeCaptureBackend(root, capture);
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      catchPromptFlow([`head -c ${n} /dev/zero | tr '\\0' a`, "exit 1"], "prompt failure"),
      cmd,
    );
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", []);
    assert.equal(status, 0);
    assert.equal(statSync(capture).size, n, "backend received all N bytes as the prompt body");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `streamed 64 MiB prompt handle must not track into RSS (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: the same fixture via `prompt ${failure}` (bare-ref, not inside a quoted
// string) behaves identically — no slurp, full contents delivered.
test("prompt ${failure}: bare-ref 64 MiB handle streams to the backend off the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-handle-bigref-"));
  try {
    const capture = join(root, "delivered.bin");
    const cmd = writeCaptureBackend(root, capture);
    const n = 64 * MIB;
    const runtime = makeRuntime(
      root,
      catchPromptFlow([`head -c ${n} /dev/zero | tr '\\0' a`, "exit 1"], "prompt ${failure}"),
      cmd,
    );
    const { status, peakDeltaBytes } = await runWithRssWatch(runtime, "main", []);
    assert.equal(status, 0);
    assert.equal(statSync(capture).size, n, "bare-ref backend received all N bytes as the prompt body");
    assert.ok(
      peakDeltaBytes < 40 * MIB,
      `streamed 64 MiB bare-ref prompt handle must not track into RSS (peak +${(peakDeltaBytes / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: the delivered body is the handle CONTENTS, never a `.jaiph/runs/…/*.out`
// path. Small payload so we can compare the delivered body byte-for-byte.
test("prompt failure: delivers the handle contents, never a run-dir path", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-handle-path-"));
  try {
    const capture = join(root, "delivered.bin");
    const cmd = writeCaptureBackend(root, capture);
    const runtime = makeRuntime(
      root,
      catchPromptFlow(["printf '%s' 'the-failure-payload'", "exit 1"], "prompt failure"),
      cmd,
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const delivered = readFileSync(capture, "utf8");
    assert.equal(delivered, "the-failure-payload", "backend received the handle's stdout contents");
    assert.doesNotMatch(delivered, /\.jaiph\/runs\/.+\.out/, "delivered body must never be a run-dir path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC: `prompt "wrap ${x}"` (interpolation inside a constructed string) still
// forces — the delivered body is the wrapped string, not the handle file alone.
test('prompt "wrap ${failure}": interpolated body forces and delivers the wrapped string', async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-handle-wrap-"));
  try {
    const capture = join(root, "delivered.bin");
    const cmd = writeCaptureBackend(root, capture);
    const runtime = makeRuntime(
      root,
      catchPromptFlow(["printf '%s' 'PAYLOAD'", "exit 1"], 'prompt "wrap ${failure} end"'),
      cmd,
    );
    const status = await runtime.runRoot("main", []);
    assert.equal(status, 0);
    const delivered = readFileSync(capture, "utf8");
    // The interpolation path forces the handle and builds a string; the delivered
    // body is the wrapped string with the payload embedded (the literal outer
    // quotes are the pre-existing quoted-body transport form, unchanged here),
    // never the raw handle file alone.
    assert.equal(delivered, '"wrap PAYLOAD end"', "interpolated body is the wrapped string, not the handle alone");
    assert.doesNotMatch(delivered, /\.jaiph\/runs\/.+\.out/, "delivered body must never be a run-dir path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
