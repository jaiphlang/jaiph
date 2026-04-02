import test from "node:test";
import assert from "node:assert/strict";
import { validatePromptReturnsSchema, validatePromptStepReturns } from "./validate-prompt-schema";

// --- validatePromptReturnsSchema ---

test("validatePromptReturnsSchema: accepts valid single-field schema", () => {
  validatePromptReturnsSchema("{ name: string }", "test.jh", 1, 1);
});

test("validatePromptReturnsSchema: accepts valid multi-field schema", () => {
  validatePromptReturnsSchema("{ name: string, count: number, active: boolean }", "test.jh", 1, 1);
});

test("validatePromptReturnsSchema: accepts empty braces (no fields)", () => {
  validatePromptReturnsSchema("{ }", "test.jh", 1, 1);
});

test("validatePromptReturnsSchema: accepts case-insensitive types", () => {
  validatePromptReturnsSchema("{ name: String, count: NUMBER, ok: Boolean }", "test.jh", 1, 1);
});

test("validatePromptReturnsSchema: rejects empty schema", () => {
  assert.throws(
    () => validatePromptReturnsSchema("", "test.jh", 1, 1),
    /returns schema cannot be empty/,
  );
});

test("validatePromptReturnsSchema: rejects whitespace-only schema", () => {
  assert.throws(
    () => validatePromptReturnsSchema("   ", "test.jh", 1, 1),
    /returns schema cannot be empty/,
  );
});

test("validatePromptReturnsSchema: rejects array types", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ items: string[] }", "test.jh", 1, 1),
    /no arrays or union types/,
  );
});

test("validatePromptReturnsSchema: rejects union types", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ name: string | number }", "test.jh", 1, 1),
    /no arrays or union types/,
  );
});

test("validatePromptReturnsSchema: rejects unsupported type", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ data: object }", "test.jh", 1, 1),
    /unsupported type in returns schema: "object"/,
  );
});

test("validatePromptReturnsSchema: rejects malformed entry", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ just-a-value }", "test.jh", 1, 1),
    /invalid returns schema entry/,
  );
});

// --- validatePromptStepReturns ---

test("validatePromptStepReturns: no error when no returns", () => {
  const step = {
    type: "prompt" as const,
    raw: 'prompt "hello"',
    loc: { line: 1, col: 1 },
  };
  validatePromptStepReturns(step, "test.jh");
});

test("validatePromptStepReturns: no error when returns with capture", () => {
  const step = {
    type: "prompt" as const,
    raw: '"hello"',
    loc: { line: 1, col: 1 },
    captureName: "result",
    returns: "{ name: string }",
  };
  validatePromptStepReturns(step, "test.jh");
});

test("validatePromptStepReturns: rejects returns without capture", () => {
  const step = {
    type: "prompt" as const,
    raw: 'prompt "hello" returns "{ name: string }"',
    loc: { line: 1, col: 1 },
    returns: "{ name: string }",
  };
  assert.throws(
    () => validatePromptStepReturns(step, "test.jh"),
    /must capture to a variable/,
  );
});
