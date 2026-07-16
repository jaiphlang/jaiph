import test from "node:test";
import assert from "node:assert/strict";
import { createStepIdleOutputWarn, parseStepIdleWarnSec } from "./step-idle-warn";
import { RuntimeEventEmitter } from "./runtime-event-emitter";

test("parseStepIdleWarnSec: defaults to 180", () => {
  assert.equal(parseStepIdleWarnSec({}), 180);
});

test("parseStepIdleWarnSec: honors env override and 0 disables", () => {
  assert.equal(parseStepIdleWarnSec({ JAIPH_STEP_IDLE_WARN_SEC: "90" }), 90);
  assert.equal(parseStepIdleWarnSec({ JAIPH_STEP_IDLE_WARN_SEC: "0" }), 0);
  assert.equal(parseStepIdleWarnSec({ JAIPH_STEP_IDLE_WARN_SEC: "bad" }), 180);
});

function makeEmitter() {
  const messages: Array<{ type: string; message: string }> = [];
  const emitter = {
    emitLog(type: "LOG" | "LOGERR" | "LOGWARN", message: string) {
      messages.push({ type, message });
    },
  } as unknown as RuntimeEventEmitter;
  return { emitter, messages };
}

test("createStepIdleOutputWarn: emits incremental LOGWARNs during continuous silence", async () => {
  const { emitter, messages } = makeEmitter();
  const warn = createStepIdleOutputWarn(emitter, "script", "sleep_impl", {
    JAIPH_STEP_IDLE_WARN_SEC: "1",
  }, { checkIntervalMs: 100 });
  assert.ok(warn);

  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(messages.length >= 2, `expected >=2 warnings, got ${messages.length}`);
  for (const msg of messages) {
    assert.equal(msg.type, "LOGWARN");
    assert.match(msg.message, /^script sleep_impl: no new output for \d+s$/);
  }

  warn!.stop();
});

test("createStepIdleOutputWarn: bump resets incremental cadence", async () => {
  const { emitter, messages } = makeEmitter();
  const warn = createStepIdleOutputWarn(emitter, "script", "sleep_impl", {
    JAIPH_STEP_IDLE_WARN_SEC: "1",
  }, { checkIntervalMs: 100 });
  assert.ok(warn);

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(messages.length, 1);

  warn!.bump();
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(messages.length, 2);
  assert.match(messages[1]!.message, /^script sleep_impl: no new output for \d+s$/);

  warn!.stop();
});

test("createStepIdleOutputWarn: returns null when disabled", () => {
  const emitter = { emitLog() {} } as unknown as RuntimeEventEmitter;
  assert.equal(
    createStepIdleOutputWarn(emitter, "script", "x", { JAIPH_STEP_IDLE_WARN_SEC: "0" }),
    null,
  );
});
