import test from "node:test";
import assert from "node:assert/strict";
import { createRunEmitter } from "../src/cli/run/emitter";
import { registerTTYSubscriber, type TTYContext } from "../src/cli/run/stderr-handler";
import type { StepEvent } from "../src/cli/run/events";

test("registerTTYSubscriber: STEP_END fallback indent uses event depth", () => {
  const emitter = createRunEmitter();
  const ctx: TTYContext = {
    isTTY: false,
    colorEnabled: false,
    startedAt: Date.now(),
    runningInterval: undefined,
  };
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stdout.write;

  try {
    registerTTYSubscriber(emitter, ctx);
    const event: StepEvent = {
      type: "STEP_END",
      func: "jaiph::prompt",
      kind: "prompt",
      name: "prompt",
      ts: "2026-01-01T00:00:00Z",
      status: 0,
      elapsed_ms: 1000,
      out_file: "",
      err_file: "",
      id: "run:1:2",
      parent_id: "run:1:1",
      seq: 2,
      depth: 2,
      run_id: "run-1",
      params: [],
      dispatched: false,
      channel: "",
      out_content: "",
      err_content: "",
    };
    emitter.emit("step_end", { event, eventId: "missing-start-id", isRoot: false });
  } finally {
    (process.stdout.write as unknown as typeof process.stdout.write) = originalWrite as typeof process.stdout.write;
  }

  const output = writes.join("");
  assert.match(output, /^  ·   ✓ prompt prompt \(1s\)\n$/);
});
