import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { waitForRunExit } from "./lifecycle";

function fakeChild(): ChildProcess {
  return new EventEmitter() as ChildProcess;
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
