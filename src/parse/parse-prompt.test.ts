import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptStep } from "./prompt";
import { createTrivia } from "./trivia";

const trivia = createTrivia();

/**
 * `parsePromptStep` now returns an `exec` step whose `body` is an `Expr.prompt`.
 * The bodyKind / bodyIdentifier / rawBody trivia hangs off that inner Expr.
 */
function unwrapPrompt(step: import("../types").WorkflowStepDef): import("../types").Expr & { kind: "prompt" } {
  if (step.type !== "exec" || step.body.kind !== "prompt") {
    throw new Error(`expected exec step with prompt body, got ${step.type}`);
  }
  return step.body;
}

// === parsePromptStep: single-line string literal ===

test("parsePromptStep: parses simple single-line prompt", () => {
  const lines = ['  prompt "Hello world"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Hello world"', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"Hello world"');
  assert.equal(body.loc.line, 1);
  assert.equal(body.loc.col, 3);
  if (result.step.type === "exec") {
    assert.equal(result.step.captureName, undefined);
  }
  assert.equal(body.returns, undefined);
  assert.equal(trivia.getNode(body)?.bodyKind, "string");
});

test("parsePromptStep: parses captured prompt", () => {
  const lines = ['  answer = prompt "What?"'];
  const result = parsePromptStep("test.jh", lines, 0, '"What?"', 3, "answer", trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"What?"');
  if (result.step.type === "exec") {
    assert.equal(result.step.captureName, "answer");
  }
  assert.equal(trivia.getNode(body)?.bodyKind, "string");
});

test("parsePromptStep: parses prompt with returns schema (double-quoted)", () => {
  const lines = ['  prompt "Classify" returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Classify" returns "{ type: string }"', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"Classify"');
  assert.equal(body.returns, "{ type: string }");
});

test("parsePromptStep: rejects single-quoted returns schema", () => {
  const lines = ["  prompt \"Classify\" returns '{ type: string }'"];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "\"Classify\" returns '{ type: string }'", 3, undefined, trivia),
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
    () => parsePromptStep("test.jh", lines, 0, '"Hello', 3, undefined, trivia),
    /multiline prompt strings are no longer supported/,
  );
});

// === parsePromptStep: identifier body ===

test("parsePromptStep: parses bare identifier prompt", () => {
  const lines = ['  prompt myVar'];
  const result = parsePromptStep("test.jh", lines, 0, "myVar", 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(trivia.getNode(body)?.bodyKind, "identifier");
  assert.equal(trivia.getNode(body)?.bodyIdentifier, "myVar");
  assert.equal(body.raw, '"${myVar}"');
  assert.equal(body.returns, undefined);
});

test("parsePromptStep: parses identifier prompt with returns", () => {
  const lines = ['  prompt myVar returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, 'myVar returns "{ type: string }"', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(trivia.getNode(body)?.bodyKind, "identifier");
  assert.equal(trivia.getNode(body)?.bodyIdentifier, "myVar");
  assert.equal(body.returns, "{ type: string }");
});

test("parsePromptStep: parses captured identifier prompt", () => {
  const lines = ['  answer = prompt text'];
  const result = parsePromptStep("test.jh", lines, 0, "text", 3, "answer", trivia);
  const body = unwrapPrompt(result.step);
  if (result.step.type === "exec") {
    assert.equal(result.step.captureName, "answer");
  }
  assert.equal(trivia.getNode(body)?.bodyKind, "identifier");
  assert.equal(trivia.getNode(body)?.bodyIdentifier, "text");
});

// === parsePromptStep: triple-quoted block ===

test("parsePromptStep: parses triple-quoted block prompt", () => {
  const lines = [
    '  prompt """',
    'You are a helpful assistant.',
    'Analyze the following: ${input}',
    '"""',
  ];
  const result = parsePromptStep("test.jh", lines, 0, '"""', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(trivia.getNode(body)?.bodyKind, "triple_quoted");
  assert.ok(body.raw.includes("You are a helpful assistant."));
  assert.ok(body.raw.includes("${input}"));
});

test("parsePromptStep: parses captured triple-quoted block prompt", () => {
  const lines = [
    '  answer = prompt """',
    'Hello multiline',
    '"""',
  ];
  const result = parsePromptStep("test.jh", lines, 0, '"""', 3, "answer", trivia);
  const body = unwrapPrompt(result.step);
  if (result.step.type === "exec") {
    assert.equal(result.step.captureName, "answer");
  }
  assert.equal(trivia.getNode(body)?.bodyKind, "triple_quoted");
});

test("parsePromptStep: triple-quoted block may be followed by returns on the next line", () => {
  const lines = [
    '  answer = prompt """',
    "Hello",
    '"""',
    'returns "{ role: string }"',
  ];
  const result = parsePromptStep("test.jh", lines, 0, '"""', 3, "answer", trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(trivia.getNode(body)?.bodyKind, "triple_quoted");
  assert.equal(body.returns, "{ role: string }");
  assert.equal(result.nextLineIdx, 3);
});

test("parsePromptStep: triple-quoted block may close with returns on same line", () => {
  const lines = [
    '  answer = prompt """',
    "Hello",
    '""" returns "{ role: string }"',
  ];
  const result = parsePromptStep("test.jh", lines, 0, '"""', 3, "answer", trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(trivia.getNode(body)?.bodyKind, "triple_quoted");
  assert.equal(body.returns, "{ role: string }");
  assert.equal(result.nextLineIdx, 2);
});

test("parsePromptStep: unterminated triple-quoted block throws", () => {
  const lines = [
    '  prompt """',
    'Hello multiline',
    'no closing triple-quote',
  ];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"""', 3, undefined, trivia),
    /unterminated triple-quoted block/,
  );
});

test("parsePromptStep: triple-backtick fence is rejected with guidance", () => {
  const lines = [
    '  prompt ```',
    'Hello multiline',
    '```',
  ];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "```", 3, undefined, trivia),
    /prompt blocks use triple quotes.*triple backticks are for scripts/,
  );
});

test("parsePromptStep: unterminated single-line string throws", () => {
  const lines = ['  prompt "Hello'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello', 3, undefined, trivia),
    /multiline prompt strings are no longer supported/,
  );
});

test("parsePromptStep: invalid text after prompt string throws", () => {
  const lines = ['  prompt "Hello" garbage'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello" garbage', 3, undefined, trivia),
    /expected keyword "returns"/,
  );
});

test("parsePromptStep: unterminated returns schema throws", () => {
  const lines = ['  prompt "Hello" returns "{ type: string'];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, '"Hello" returns "{ type: string', 3, undefined, trivia),
    /unterminated returns schema/,
  );
});

test("parsePromptStep: returns with double-quoted schema", () => {
  const lines = ['  prompt "Classify" returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, '"Classify" returns "{ type: string }"', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.returns, "{ type: string }");
});

// === parsePromptStep: bare ${name} interpolation ref ===

test("parsePromptStep: parses bare ${name} interpolation ref", () => {
  const lines = ["  prompt ${myVar}"];
  const result = parsePromptStep("test.jh", lines, 0, "${myVar}", 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"${myVar}"');
  assert.equal(trivia.getNode(body)?.bodyKind, "string");
});

test("parsePromptStep: parses bare ${name.field} interpolation ref", () => {
  const lines = ["  prompt ${result.text}"];
  const result = parsePromptStep("test.jh", lines, 0, "${result.text}", 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"${result.text}"');
});

test("parsePromptStep: parses ${name} with returns schema", () => {
  const lines = ['  prompt ${myVar} returns "{ type: string }"'];
  const result = parsePromptStep("test.jh", lines, 0, '${myVar} returns "{ type: string }"', 3, undefined, trivia);
  const body = unwrapPrompt(result.step);
  assert.equal(body.raw, '"${myVar}"');
  assert.equal(body.returns, "{ type: string }");
});

test("parsePromptStep: rejects unclosed ${model interpolation ref", () => {
  const lines = ["  prompt ${model"];
  assert.throws(
    () => parsePromptStep("test.jh", lines, 0, "${model", 3, undefined, trivia),
    /prompt body must be/,
  );
});
