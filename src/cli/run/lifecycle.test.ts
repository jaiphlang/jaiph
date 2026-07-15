import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { waitForRunExit, setupRunSignalHandlers } from "./lifecycle";

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

test("waitForRunExit resolves on immediate exit (Docker early container exit)", async () => {
  const child = fakeChild();
  const promise = waitForRunExit(child, undefined, { closeGraceMs: 50 });
  // Simulate Docker container failing at startup: exit fires immediately, then close follows.
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  const result = await promise;
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
});

test("waitForRunExit resolves with signal when Docker container is killed", async () => {
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

test("setupRunSignalHandlers: SIGINT runs onSignalCleanup (Docker container-stop hook)", () => {
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

test("setupRunSignalHandlers: SIGTERM runs onSignalCleanup (Docker container-stop hook)", () => {
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
