import test from "node:test";
import assert from "node:assert/strict";
import { colorize, formatCompletedLine, formatStartLine } from "../src/cli/run/display";

// === colorize ===

test("colorize: returns plain text when color disabled", () => {
  assert.equal(colorize("hello", "bold", false), "hello");
});

test("colorize: wraps text with bold ANSI code when enabled", () => {
  const result = colorize("hello", "bold", true);
  assert.equal(result, "\u001b[1mhello\u001b[0m");
});

test("colorize: wraps text with dim ANSI code when enabled", () => {
  const result = colorize("hello", "dim", true);
  assert.equal(result, "\u001b[2mhello\u001b[0m");
});

test("colorize: wraps text with green ANSI code when enabled", () => {
  const result = colorize("hello", "green", true);
  assert.equal(result, "\u001b[32mhello\u001b[0m");
});

test("colorize: wraps text with red ANSI code when enabled", () => {
  const result = colorize("hello", "red", true);
  assert.equal(result, "\u001b[31mhello\u001b[0m");
});

// === formatCompletedLine ===

test("formatCompletedLine: shows green checkmark for success (no color)", () => {
  const result = formatCompletedLine("  ", 0, 1.5, false);
  assert.ok(result.includes("✓"));
  assert.ok(result.includes("1.5s"));
});

test("formatCompletedLine: shows red cross for failure (no color)", () => {
  const result = formatCompletedLine("  ", 1, 2.3, false);
  assert.ok(result.includes("✗"));
  assert.ok(result.includes("2.3s"));
});

// === formatStartLine ===

test("formatStartLine: formats workflow kind with name", () => {
  const result = formatStartLine("  ", "workflow", "deploy", false);
  assert.ok(result.includes("workflow"));
  assert.ok(result.includes("deploy"));
});

test("formatStartLine: omits name when kind equals name", () => {
  const result = formatStartLine("  ", "rule", "rule", false);
  // Should only have "rule" once (as kind label), not "rule rule"
  const ruleCount = (result.match(/rule/g) || []).length;
  assert.equal(ruleCount, 1);
});

test("formatStartLine: shows prompt preview from params", () => {
  const params: Array<[string, string]> = [
    ["__prompt_impl", "internal"],
    ["__preview", "Review the code changes"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes("prompt"));
});
