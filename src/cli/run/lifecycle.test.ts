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
