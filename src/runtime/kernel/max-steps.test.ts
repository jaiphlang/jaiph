import test from "node:test";
import assert from "node:assert/strict";
import { parseMaxSteps, maxStepsTrippedMessage } from "./max-steps";

test("parseMaxSteps: unset / empty / invalid / non-positive disables (returns 0)", () => {
  assert.equal(parseMaxSteps({}), 0);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "" }), 0);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "bad" }), 0);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "0" }), 0);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "-5" }), 0);
});

test("parseMaxSteps: positive integer is honoured (floored)", () => {
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "1" }), 1);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "250" }), 250);
  assert.equal(parseMaxSteps({ JAIPH_MAX_STEPS: "7.9" }), 7);
});

test("maxStepsTrippedMessage: names the cap and the env var", () => {
  const msg = maxStepsTrippedMessage(3);
  assert.match(msg, /E_MAX_STEPS/);
  assert.match(msg, /JAIPH_MAX_STEPS=3/);
});
