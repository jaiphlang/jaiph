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

test("validatePromptReturnsSchema: accepts a string enum", () => {
  validatePromptReturnsSchema('{ status: "approve" | "reject" | "unsure" }', "test.jh", 1, 1);
});

test("validatePromptReturnsSchema: accepts an array of records", () => {
  validatePromptReturnsSchema(
    '{ key_changes: [{ path: string, start: number, kind: "add" | "del" }] }',
    "test.jh",
    1,
    1,
  );
});

test("validatePromptReturnsSchema: rejects postfix [] as E_PARSE", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ items: string[] }", "test.jh", 1, 1),
    /E_PARSE/,
  );
});

test("validatePromptReturnsSchema: rejects an unquoted type-union as E_PARSE", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ name: string | number }", "test.jh", 1, 1),
    /E_PARSE.*quoted string literals/,
  );
});

test("validatePromptReturnsSchema: rejects an empty enum option as E_PARSE", () => {
  assert.throws(
    () => validatePromptReturnsSchema('{ status: "a" | }', "test.jh", 1, 1),
    /E_PARSE.*empty option/,
  );
});

test("validatePromptReturnsSchema: rejects a nested array as E_PARSE", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ xs: [[{ a: string }]] }", "test.jh", 1, 1),
    /E_PARSE.*nested arrays/,
  );
});

test("validatePromptReturnsSchema: rejects a record inside a record as E_PARSE", () => {
  assert.throws(
    () => validatePromptReturnsSchema("{ xs: [{ a: { b: string } }] }", "test.jh", 1, 1),
    /E_PARSE.*record inside a record/,
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
  validatePromptStepReturns(
    { loc: { line: 1, col: 1 } },
    undefined,
    "test.jh",
  );
});

test("validatePromptStepReturns: no error when returns with capture", () => {
  validatePromptStepReturns(
    { returns: "{ name: string }", loc: { line: 1, col: 1 } },
    "result",
    "test.jh",
  );
});

test("validatePromptStepReturns: rejects returns without capture", () => {
  assert.throws(
    () => validatePromptStepReturns(
      { returns: "{ name: string }", loc: { line: 1, col: 1 } },
      undefined,
      "test.jh",
    ),
    /must capture to a variable/,
  );
});
