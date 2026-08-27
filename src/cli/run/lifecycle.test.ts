import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import {
  waitForRunExit,
  setupRunSignalHandlers,
  armRunTimeout,
  parseRunTimeoutSeconds,
} from "./lifecycle";

function fakeChild(): ChildProcess {
  // No `pid`, so terminateRunProcessGroup no-ops — no real process is signaled.
  return new EventEmitter() as ChildProcess;
}

/**
 * Run `fn` with all pre-existing listeners for `sig` detached, then restored.
 * Keeps a synthetic `process.emit(sig)` from firing the test runner's own
 * signal handlers — only the listener registered inside `fn` is invoked.
 */
function withIsolatedSignal(sig: NodeJS.Signals, fn: () => void): void {
  const existing = process.listeners(sig);
  for (const l of existing) process.removeListener(sig, l as never);
  try {
    fn();
  } finally {
    for (const l of existing) process.on(sig, l as never);
  }
}

test("waitForRunExit resolves from close event", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child);
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("waitForRunExit resolves from exit if close does not arrive", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child, undefined, { closeGraceMs: 10 });
  child.emit("exit", 0, null);
  const result = await promise;
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("waitForRunExit resolves on immediate exit (exit before close)", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child, undefined, { closeGraceMs: 50 });
  // Simulate a child failing at startup: exit fires immediately, then close follows.
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  const result = await promise;
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
});

test("waitForRunExit resolves with signal when the child is killed", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child);
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  const result = await promise;
  assert.equal(result.status, 1);
  assert.equal(result.signal, "SIGTERM");
});

test("waitForRunExit resolves when close fires before exit (race)", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child);
  child.emit("close", 0, null);
  // exit fires after close; should not cause double resolve
  child.emit("exit", 0, null);
  const result = await promise;
  assert.equal(result.status, 0);
});

test("parseRunTimeoutSeconds: unset / empty / invalid / non-positive disables (returns 0)", () => {
  assert.equal(parseRunTimeoutSeconds({}), 0);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "" }), 0);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "nope" }), 0);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "0" }), 0);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "-3" }), 0);
});

test("parseRunTimeoutSeconds: positive integer is honoured (floored)", () => {
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "1" }), 1);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "600" }), 600);
  assert.equal(parseRunTimeoutSeconds({ JAIPH_RUN_TIMEOUT: "2.9" }), 2);
});

test("armRunTimeout: disabled (0 / negative) returns an inert handle — no timer, never fires", () => {
  const child = fakeChild();
  const zero = armRunTimeout(child, 0);
  const neg = armRunTimeout(child, -5);
  assert.equal(zero.timedOut(), false);
  assert.equal(neg.timedOut(), false);
  // No pending timers: the test process is not kept alive by these handles.
  zero.cancel();
  neg.cancel();
});

test("armRunTimeout: parent terminates a real host child after the wall-clock budget (no Ctrl-C)", async () => {
  // A detached child is its own process-group leader, so terminateRunProcessGroup
  // can signal the whole group — the same path the CLI uses for a real run.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const start = Date.now();
  const timeout = armRunTimeout(child, 1, { forceKillAfterMs: 500 });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => child.once("exit", (code, signal) => res({ code, signal })),
  );
  const elapsed = Date.now() - start;
  assert.equal(timeout.timedOut(), true, "the timeout fired");
  assert.ok(elapsed >= 950, `child survived until the budget (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `child was killed soon after the budget (elapsed ${elapsed}ms)`);
  // Killed by a signal (SIGTERM, or SIGKILL if it ignored the term), not a clean exit.
  assert.notEqual(exit.signal, null, `terminated by signal, got code=${exit.code}`);
});

test("armRunTimeout: a child that exits before the budget is never signalled", async () => {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  const timeout = armRunTimeout(child, 30, { forceKillAfterMs: 500 });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => child.once("exit", (code, signal) => res({ code, signal })),
  );
  assert.equal(timeout.timedOut(), false, "the timeout never fired");
  assert.equal(exit.signal, null, "child exited cleanly on its own");
  assert.equal(exit.code, 0);
  timeout.cancel();
});

test("setupRunSignalHandlers: SIGINT runs onSignalCleanup", () => {
  withIsolatedSignal("SIGINT", () => {
    const child = fakeChild();
    let cleanupCalls = 0;
    const handlers = setupRunSignalHandlers(child, {
      forceKillAfterMs: 60_000,
      onSignalCleanup: () => { cleanupCalls += 1; },
    });
    try {
      process.emit("SIGINT");
      assert.equal(cleanupCalls, 1, "onSignalCleanup fires exactly once on SIGINT");
    } finally {
      handlers.remove();
    }
  });
});

test("setupRunSignalHandlers: SIGTERM runs onSignalCleanup", () => {
  withIsolatedSignal("SIGTERM", () => {
    const child = fakeChild();
    let cleanupCalls = 0;
    const handlers = setupRunSignalHandlers(child, {
      forceKillAfterMs: 60_000,
      onSignalCleanup: () => { cleanupCalls += 1; },
    });
    try {
      process.emit("SIGTERM");
      assert.equal(cleanupCalls, 1, "onSignalCleanup fires exactly once on SIGTERM");
    } finally {
      handlers.remove();
    }
  });
});
