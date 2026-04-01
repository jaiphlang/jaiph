import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptStep } from "./prompt";

// === parsePromptStep: single-line string literal ===

test("parsePromptStep: parses simple single-line prompt", () => {
  const lines = ['  prompt "Hello world"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Hello world"', 3);
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"Hello world"');
  assert.equal(result.step.loc.line, 1);
  assert.equal(result.step.loc.col, 3);
  assert.equal(result.step.captureName, undefined);
  assert.equal(result.step.returns, undefined);
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "string");
  }
});

test("parsePromptStep: parses captured prompt", () => {
  const lines = ['  answer = prompt "What?"'];
  const result = parsePromptStep("test.jh", lines, 0, '"What?"', 3, "answer");
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"What?"');
  assert.equal(result.step.captureName, "answer");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "string");
  }
});

test("parsePromptStep: parses prompt with returns schema (double-quoted)", () => {
  const lines = ['  prompt "Classify" returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Classify" returns "{ type: string }"', 3);
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.raw, '"Classify"');
  assert.equal(result.step.returns, "{ type: string }");
});

test("parsePromptStep: rejects single-quoted returns schema", () => {
  const lines = ["  prompt \"Classify\" returns '{ type: string }'"];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "\"Classify\" returns '{ type: string }'", 3),
    /single-quoted strings are not supported/,
  );
});

// === parsePromptStep: multiline quoted strings are rejected ===

test("parsePromptStep: multiline quoted prompt throws with clear error", () => {
  const lines = [
    '  prompt "Hello',
    '  world"',
  ];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello', 3),
    /multiline prompt strings are no longer supported; use a fenced block instead/,
  );
});

// === parsePromptStep: identifier body ===

test("parsePromptStep: parses bare identifier prompt", () => {
  const lines = ['  prompt myVar'];
  const result = parsePromptStep("test.jh", lines, 0, "myVar", 3);
  assert.equal(result.step.type, "prompt");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "identifier");
    assert.equal(result.step.bodyIdentifier, "myVar");
    assert.equal(result.step.raw, '"${myVar}"');
    assert.equal(result.step.returns, undefined);
  }
});

test("parsePromptStep: parses identifier prompt with returns", () => {
  const lines = ['  prompt myVar returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, 'myVar returns "{ type: string }"', 3);
  assert.equal(result.step.type, "prompt");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "identifier");
    assert.equal(result.step.bodyIdentifier, "myVar");
    assert.equal(result.step.returns, "{ type: string }");
  }
});

test("parsePromptStep: parses captured identifier prompt", () => {
  const lines = ['  answer = prompt text'];
  const result = parsePromptStep("test.jh", lines, 0, "text", 3, "answer");
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.captureName, "answer");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "identifier");
    assert.equal(result.step.bodyIdentifier, "text");
  }
});

// === parsePromptStep: fenced block ===

test("parsePromptStep: parses fenced block prompt", () => {
  const lines = [
    '  prompt ```',
    'You are a helpful assistant.',
    'Analyze the following: ${input}',
    '```',
  ];
  const result = parsePromptStep("test.jh", lines, 0, "```", 3);
  assert.equal(result.step.type, "prompt");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "fenced");
    // raw contains the body wrapped in quotes for runtime interpolation
    assert.ok(result.step.raw.includes("You are a helpful assistant."));
    assert.ok(result.step.raw.includes("${input}"));
  }
});

test("parsePromptStep: parses captured fenced block prompt", () => {
  const lines = [
    '  answer = prompt ```',
    'Hello multiline',
    '```',
  ];
  const result = parsePromptStep("test.jh", lines, 0, "```", 3, "answer");
  assert.equal(result.step.type, "prompt");
  assert.equal(result.step.captureName, "answer");
  if (result.step.type === "prompt") {
    assert.equal(result.step.bodyKind, "fenced");
  }
});

test("parsePromptStep: unterminated fenced block throws", () => {
  const lines = [
    '  prompt ```',
    'Hello multiline',
    'no closing fence',
  ];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "```", 3),
    /unterminated fenced block/,
  );
});

// === parsePromptStep: errors ===

test("parsePromptStep: unterminated single-line string throws", () => {
  const lines = ['  prompt "Hello'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello', 3),
    /multiline prompt strings are no longer supported/,
  );
});

test("parsePromptStep: invalid text after prompt string throws", () => {
  const lines = ['  prompt "Hello" garbage'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello" garbage', 3),
    /expected keyword "returns"/,
  );
});

test("parsePromptStep: unterminated returns schema throws", () => {
  const lines = ['  prompt "Hello" returns "{ type: string'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello" returns "{ type: string', 3),
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
