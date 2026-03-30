import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptStep } from "./prompt";

// === parsePromptStep: single-line ===

test("parsePromptStep: parses simple single-line prompt", () => {
  const lines = ['  prompt "Hello world"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Hello world"', 3);
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"Hello world"');
  assert.equal(result.step.loc.line, 1);
  assert.equal(result.step.loc.col, 3);
  assert.equal(result.step.captureName, undefined);
  assert.equal(result.step.returns, undefined);
});

test("parsePromptStep: parses captured prompt", () => {
  const lines = ['  answer = prompt "What?"'];
  const result = parsePromptStep("test.jh", lines, 0, '"What?"', 3, "answer");
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"What?"');
  assert.equal(result.step.captureName, "answer");
});

test("parsePromptStep: parses prompt with returns schema", () => {
  const lines = ["  prompt \"Classify\" returns '{ type: string }'"];
  const result = parsePromptStep("test.jh", lines, 0, "\"Classify\" returns '{ type: string }'", 3);
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"Classify"');
  assert.equal(result.step.returns, "{ type: string }");
});

// === parsePromptStep: multiline ===

test("parsePromptStep: parses multiline prompt", () => {
  const lines = [
    '  prompt "Hello',
    '  world"',
  ];
  const result = parsePromptStep("test.jh", lines, 0, '"Hello', 3);
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"Hello\n  world"');
});

test("parsePromptStep: unterminated multiline prompt throws", () => {
  const lines = [
    '  prompt "Hello',
    '  world',
  ];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello', 3),
    /unterminated prompt string/,
  );
});

// === parsePromptStep: errors ===

test("parsePromptStep: prompt not starting with quote throws (uncaptured)", () => {
  const lines = ['  prompt hello'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "hello", 3),
    (err: any) => err.message.includes("E_PARSE") && err.message.includes('prompt must match: prompt "<text>"'),
  );
});

test("parsePromptStep: prompt not starting with quote throws (captured)", () => {
  const lines = ['  answer = prompt hello'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "hello", 3, "answer"),
    (err: any) => err.message.includes("E_PARSE") && err.message.includes('prompt must match: name = prompt "<text>"'),
  );
});

// === parsePromptStep: returns schema edge cases ===

test("parsePromptStep: invalid text after prompt string throws", () => {
  const lines = ['  prompt "Hello" garbage'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello" garbage', 3),
    /expected keyword "returns"/,
  );
});

test("parsePromptStep: unterminated returns schema throws", () => {
  const lines = ["  prompt \"Hello\" returns '{ type: string"];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "\"Hello\" returns '{ type: string", 3),
    /unterminated returns schema/,
  );
});

test("parsePromptStep: returns with double-quoted schema", () => {
  const lines = ['  prompt "Classify" returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Classify" returns "{ type: string }"', 3);
  assert.equal(result.step.type, "prompt");
  if (result.step.type === "prompt") {
    assert.equal(result.step.returns, "{ type: string }");
  }
});
