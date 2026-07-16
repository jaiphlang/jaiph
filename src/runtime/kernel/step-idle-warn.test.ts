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

test("createStepIdleOutputWarn: emits LOGWARN after idle threshold", async () => {
  const messages: Array<{ type: string; message: string }> = [];
  const emitter = {
    emitLog(type: "LOG" | "LOGERR" | "LOGWARN", message: string) {
      messages.push({ type, message });
    },
  } as unknown as RuntimeEventEmitter;

  const warn = createStepIdleOutputWarn(emitter, "script", "sleep_impl", {
    JAIPH_STEP_IDLE_WARN_SEC: "1",
  }, { checkIntervalMs: 100 });
  assert.ok(warn);

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.type, "LOGWARN");
  assert.match(messages[0]!.message, /^script sleep_impl: no output for \d+s$/);

  warn!.bump();
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(messages.length, 2);
  assert.match(messages[1]!.message, /^script sleep_impl: no output for \d+s$/);

  warn!.stop();
});

test("createStepIdleOutputWarn: returns null when disabled", () => {
  const emitter = { emitLog() {} } as unknown as RuntimeEventEmitter;
  assert.equal(
    createStepIdleOutputWarn(emitter, "script", "x", { JAIPH_STEP_IDLE_WARN_SEC: "0" }),
    null,
  );
});
