import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

/**
 * Build a fake agent script (executed via JAIPH_AGENT_COMMAND, custom-command
 * path — name != "cursor-agent" so stdout is captured raw, not parsed as
 * stream-json) that fails the first `failTimes` calls (exit 1) and succeeds
 * on the (failTimes+1)-th call (exit 0, writing `successPayload` to stdout).
 * Each call appends one line to `callsLog` so tests count invocations.
 */
function writeFakeAgent(opts: {
  agentPath: string;
  counterFile: string;
  callsLog: string;
  failTimes: number;
  successPayload: string;
}): void {
  const lines = [
    "#!/usr/bin/env bash",
    "set -u",
    // Drain stdin (the prompt is piped via stdin for custom commands).
    "cat >/dev/null 2>&1 || true",
    `echo call >> "${opts.callsLog}"`,
    `current=$(cat "${opts.counterFile}" 2>/dev/null || echo 0)`,
    `if [ "$current" -lt ${opts.failTimes} ]; then`,
    `  echo $((current + 1)) > "${opts.counterFile}"`,
    `  echo "fake-agent: simulated transport failure (attempt $((current + 1)))" >&2`,
    "  exit 1",
    "fi",
    `printf '%s' "${opts.successPayload}"`,
    "",
  ];
  writeFileSync(opts.agentPath, lines.join("\n"), { mode: 0o755 });
}

function readSummaryEvents(summaryFile: string): Array<Record<string, unknown>> {
  return readFileSync(summaryFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Run a callback with `process.env.JAIPH_RUN_SUMMARY_FILE` bound to the
 * runtime's summary file. Required because `appendRunSummaryLine` reads
 * the path from process.env, not the runtime's local env copy.
 */
async function withSummaryEnv<T>(summaryFile: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.JAIPH_RUN_SUMMARY_FILE;
  process.env.JAIPH_RUN_SUMMARY_FILE = summaryFile;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
    else process.env.JAIPH_RUN_SUMMARY_FILE = prev;
  }
}

test("prompt retry: success on attempt N+1 returns { ok: true } with successful attempt's value", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-success-"));
  try {
    const jh = join(root, "succeeds.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  const r = prompt "x"',
        "  return r",
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 2,
      successPayload: "all-good-output",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
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
      promptRetryDelays: [10, 20, 30, 40, 50],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0, "workflow should succeed once prompt succeeds on retry");

    const returnFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnFile), "return_value.txt should be written on success");
    assert.equal(readFileSync(returnFile, "utf8"), "all-good-output");

    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 3, "agent should be invoked 3 times (2 failures + 1 success)");
    assert.deepEqual(sleepCalls, [10, 20], "two delays before the successful third attempt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: exhausting retries on default-length schedule makes exactly 6 executePrompt calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-exhaust-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "never-reached",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
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
      // 5 delays + 1 initial = 6 attempts total, mirroring the default schedule shape.
      promptRetryDelays: [1, 2, 3, 4, 5],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1, "workflow should fail after retries exhausted");

    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 6, "exactly 6 total executePrompt calls (1 + 5 retries)");
    assert.deepEqual(sleepCalls, [1, 2, 3, 4, 5], "delays requested between attempts equal the schedule");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: default schedule values are passed to sleep in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-default-schedule-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
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
      // No promptRetryDelays override → default schedule applies.
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1);
    assert.deepEqual(
      sleepCalls,
      [15_000, 60_000, 600_000, 1_800_000, 7_200_000],
      "sleep called with the exact default schedule in order",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: enclosing run+catch fires after retries are exhausted (compose-below-recover)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-catch-"));
  try {
    const jh = join(root, "with_catch.jh");
    // Nest the prompt inside a callee workflow so we can attach `catch` at
    // the calling `run` site (the parser rejects `prompt` inside rules).
    writeFileSync(
      jh,
      [
        "workflow inner() {",
        '  prompt "x"',
        "}",
        "",
        "workflow default() {",
        "  run inner() catch (failure) {",
        '    return "recovered"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
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
      promptRetryDelays: [1, 2],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 0, "catch branch should recover and the workflow should succeed");

    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 3, "retries are exhausted (3 attempts) before catch fires");
    assert.deepEqual(sleepCalls, [1, 2]);

    const returnFile = join(runtime.getRunDir(), "return_value.txt");
    assert.ok(existsSync(returnFile));
    assert.equal(readFileSync(returnFile, "utf8"), "recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: invalid JSON from prompt with returns schema is NOT retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-bad-json-"));
  try {
    const jh = join(root, "schema.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  const r = prompt "x" returns "{ verdict: string }"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    // Agent succeeds (exit 0) but emits non-JSON output, so post-processing fails.
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 0,
      successPayload: "this is not JSON",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
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
      promptRetryDelays: [10, 20, 30],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1, "invalid JSON should fail the step");

    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "schema/JSON failures must not trigger retry");
    assert.deepEqual(sleepCalls, [], "sleep must not be called for deterministic post-processing failures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: every failed attempt and the final termination emit LOGERR with attempt info", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-logerr-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

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
      promptRetryDelays: [10, 20],
      sleep: async () => {},
    });
    const status = await withSummaryEnv(runtime.getSummaryFile(), () => runtime.runDefault([]));
    assert.equal(status, 1);

    const events = readSummaryEvents(runtime.getSummaryFile());
    const logerrs = events.filter((e) => e.type === "LOGERR").map((e) => String(e.message));
    // Three failed attempts: attempt 1 with retry-in-10ms, attempt 2 with retry-in-20ms,
    // attempt 3 with retries-exhausted termination.
    assert.equal(logerrs.length, 3, `expected 3 LOGERR entries, got ${logerrs.length}: ${logerrs.join(" | ")}`);
    assert.match(logerrs[0]!, /prompt attempt 1\/3 failed/);
    assert.match(logerrs[0]!, /retrying in 10ms/);
    assert.match(logerrs[1]!, /prompt attempt 2\/3 failed/);
    assert.match(logerrs[1]!, /retrying in 20ms/);
    assert.match(logerrs[2]!, /prompt attempt 3\/3 failed/);
    assert.match(logerrs[2]!, /retries exhausted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: LOGERR is emitted even when no recover/catch is present", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-logerr-no-catch-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

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
      promptRetryDelays: [1],
      sleep: async () => {},
    });
    await withSummaryEnv(runtime.getSummaryFile(), () => runtime.runDefault([]));
    const events = readSummaryEvents(runtime.getSummaryFile());
    const logerrs = events.filter((e) => e.type === "LOGERR");
    assert.ok(logerrs.length >= 1, "at least one LOGERR even without recover/catch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: JAIPH_PROMPT_RETRY=0 disables retry — 1 attempt, sleep never called", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-disabled-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
        JAIPH_PROMPT_RETRY: "0",
      },
      cwd: root,
      suppressLiveEvents: true,
      // No constructor override → env is consulted.
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1);
    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "exactly 1 attempt with retries disabled");
    assert.deepEqual(sleepCalls, [], "sleep must not be called with retries disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: JAIPH_PROMPT_RETRY_DELAYS overrides the default schedule", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-env-override-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
        JAIPH_PROMPT_RETRY_DELAYS: "7,8,9",
      },
      cwd: root,
      suppressLiveEvents: true,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1);
    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 4, "1 initial + 3 retries");
    assert.deepEqual(sleepCalls, [7, 8, 9]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: invalid JAIPH_PROMPT_RETRY_DELAYS errors clearly without silent fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-bad-env-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
    const runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
        JAIPH_PROMPT_RETRY_DELAYS: "10,oops,30",
      },
      cwd: root,
      suppressLiveEvents: true,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    const status = await withSummaryEnv(runtime.getSummaryFile(), () => runtime.runDefault([]));
    assert.equal(status, 1, "workflow should fail with invalid config");
    // Step fails before executePrompt is called.
    const calls = existsSync(callsLog) ? readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : [];
    assert.equal(calls.length, 0, "executePrompt should not run when retry config is invalid");
    assert.deepEqual(sleepCalls, []);
    const summary = readFileSync(runtime.getSummaryFile(), "utf8");
    assert.match(summary, /prompt retry config invalid/);
    assert.match(summary, /JAIPH_PROMPT_RETRY_DELAYS contains invalid entry [^a-z]*oops/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt retry: abort during backoff sleep halts further executePrompt calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-retry-abort-"));
  try {
    const jh = join(root, "always_fail.jh");
    writeFileSync(
      jh,
      [
        "workflow default() {",
        '  prompt "x"',
        "}",
        "",
      ].join("\n"),
    );
    const counterFile = join(root, "counter");
    const callsLog = join(root, "calls.log");
    const agent = join(root, "fake-agent");
    writeFakeAgent({
      agentPath: agent,
      counterFile,
      callsLog,
      failTimes: 999,
      successPayload: "n/a",
    });

    const graph = buildRuntimeGraph(jh);
    const sleepCalls: number[] = [];
    let runtime: NodeWorkflowRuntime;
    const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
      sleepCalls.push(ms);
      // Simulate an in-progress wait that observes the runtime's AbortSignal.
      // The retry loop should reject this promise the moment abort() fires.
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted-by-test"));
          return;
        }
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error("aborted-by-test"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // Trigger the actual abort from inside the sleep so the loop is
        // genuinely awaiting when it fires.
        setImmediate(() => runtime.abort());
      });
    };
    runtime = new NodeWorkflowRuntime(graph, {
      env: {
        ...process.env,
        JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_AGENT_COMMAND: agent,
        JAIPH_WORKSPACE: root,
      },
      cwd: root,
      suppressLiveEvents: true,
      promptRetryDelays: [10, 20, 30, 40, 50],
      sleep,
    });
    const status = await runtime.runDefault([]);
    assert.equal(status, 1);
    const calls = readFileSync(callsLog, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "after abort fires during the first backoff, no second attempt should run");
    assert.equal(sleepCalls.length, 1, "only the first sleep is requested before abort kicks in");
    assert.ok(runtime.isAborted(), "runtime.isAborted() should be true after abort()");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
