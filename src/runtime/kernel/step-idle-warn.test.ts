import test from "node:test";
import assert from "node:assert/strict";
import {
  createStepIdleOutputWarn,
  parseStepIdleKillSec,
  parseStepIdleWarnSec,
} from "./step-idle-warn";
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

// AC4: default kill threshold is 3600s when unset; env override and 0-disable
// honoured; invalid falls back to the default.
test("parseStepIdleKillSec: defaults to 3600 and honors overrides", () => {
  assert.equal(parseStepIdleKillSec({}), 3600);
  assert.equal(parseStepIdleKillSec({ JAIPH_STEP_IDLE_KILL_SEC: "" }), 3600);
  assert.equal(parseStepIdleKillSec({ JAIPH_STEP_IDLE_KILL_SEC: "5" }), 5);
  assert.equal(parseStepIdleKillSec({ JAIPH_STEP_IDLE_KILL_SEC: "0" }), 0);
  assert.equal(parseStepIdleKillSec({ JAIPH_STEP_IDLE_KILL_SEC: "bad" }), 3600);
});

// AC1 (unit): after the kill threshold of silence the tracker emits a single
// LOGERR naming the step + idle duration and invokes onIdleKill exactly once.
test("createStepIdleOutputWarn: idle kill emits LOGERR and fires onIdleKill once", async () => {
  const { emitter, messages } = makeEmitter();
  let killCalls = 0;
  const warn = createStepIdleOutputWarn(
    emitter,
    "script",
    "hang_impl",
    { JAIPH_STEP_IDLE_WARN_SEC: "0", JAIPH_STEP_IDLE_KILL_SEC: "1" },
    { checkIntervalMs: 100, onIdleKill: () => (killCalls += 1) },
  );
  assert.ok(warn);

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(killCalls, 1, "onIdleKill fires exactly once");
  const errs = messages.filter((m) => m.type === "LOGERR");
  assert.equal(errs.length, 1, "exactly one LOGERR emitted");
  assert.match(errs[0]!.message, /^script hang_impl: no new output for \d+s; terminating idle step$/);
  // No further kills or errors after termination even as the clock keeps ticking.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(killCalls, 1);
  assert.equal(messages.filter((m) => m.type === "LOGERR").length, 1);

  warn!.stop();
});

// AC2: new output before the kill threshold resets the idle clock (no kill).
test("createStepIdleOutputWarn: bump before kill threshold prevents the kill", async () => {
  const { emitter, messages } = makeEmitter();
  let killCalls = 0;
  const warn = createStepIdleOutputWarn(
    emitter,
    "script",
    "busy_impl",
    { JAIPH_STEP_IDLE_WARN_SEC: "0", JAIPH_STEP_IDLE_KILL_SEC: "1" },
    { checkIntervalMs: 100, onIdleKill: () => (killCalls += 1) },
  );
  assert.ok(warn);

  // Keep bumping faster than the 1s threshold for ~1.5s: never crosses it.
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    warn!.bump();
  }
  assert.equal(killCalls, 0, "kill never fires while output keeps arriving");
  assert.equal(messages.filter((m) => m.type === "LOGERR").length, 0);

  warn!.stop();
});

// AC3: JAIPH_STEP_IDLE_KILL_SEC=0 leaves warn-only behaviour (no kill).
test("createStepIdleOutputWarn: kill disabled keeps warn-only behaviour", async () => {
  const { emitter, messages } = makeEmitter();
  let killCalls = 0;
  const warn = createStepIdleOutputWarn(
    emitter,
    "script",
    "warn_only",
    { JAIPH_STEP_IDLE_WARN_SEC: "1", JAIPH_STEP_IDLE_KILL_SEC: "0" },
    { checkIntervalMs: 100, onIdleKill: () => (killCalls += 1) },
  );
  assert.ok(warn);

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(killCalls, 0, "kill disabled: onIdleKill never fires");
  assert.equal(messages.filter((m) => m.type === "LOGERR").length, 0, "no LOGERR emitted");
  assert.ok(
    messages.some((m) => m.type === "LOGWARN"),
    "warn cadence still fires",
  );

  warn!.stop();
});
