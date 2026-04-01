import test from "node:test";
import assert from "node:assert/strict";
import { colorize, formatCompletedLine, formatHeartbeatLine, formatStartLine, sanitizeMultilineLogForTerminal } from "./display";

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
  const result = formatCompletedLine("  ", 0, 1, false);
  assert.ok(result.includes("✓"));
  assert.ok(result.includes("(1s)"));
});

test("formatCompletedLine: shows red cross for failure (no color)", () => {
  const result = formatCompletedLine("  ", 1, 2, false);
  assert.ok(result.includes("✗"));
  assert.ok(result.includes("(2s)"));
});

test("formatCompletedLine: success with workflow kind and name (no color)", () => {
  const result = formatCompletedLine("  ", 0, 0, false, "workflow", "scanner");
  assert.equal(result, "✓ workflow scanner (0s)");
});

test("formatCompletedLine: success with rule kind and name (no color)", () => {
  const result = formatCompletedLine("  ", 0, 3, false, "rule", "ci_passes");
  assert.equal(result, "✓ rule ci_passes (3s)");
});

test("formatCompletedLine: success with script kind and name (no color)", () => {
  const result = formatCompletedLine("  ", 0, 1, false, "script", "deploy");
  assert.equal(result, "✓ script deploy (1s)");
});

test("formatCompletedLine: success with prompt kind and name (no color)", () => {
  const result = formatCompletedLine("  ", 0, 5, false, "prompt", "prompt");
  assert.equal(result, "✓ prompt prompt (5s)");
});

test("formatCompletedLine: failure with workflow kind and name (no color)", () => {
  const result = formatCompletedLine("  ", 1, 2, false, "workflow", "reviewer");
  assert.equal(result, "✗ workflow reviewer (2s)");
});

test("formatCompletedLine: success with kind/name has green marker and dim label (color enabled)", () => {
  const result = formatCompletedLine("  ", 0, 0, true, "workflow", "scanner");
  // Green checkmark
  assert.ok(result.includes("\u001b[32m✓\u001b[0m"));
  // Dim label with kind + name + elapsed
  assert.ok(result.includes("\u001b[2mworkflow scanner (0s)\u001b[0m"));
});

test("formatCompletedLine: failure with kind/name has red marker and label (color enabled)", () => {
  const result = formatCompletedLine("  ", 1, 2, true, "workflow", "reviewer");
  // Red failure line
  assert.ok(result.includes("\u001b[31m✗ workflow reviewer (2s)\u001b[0m"));
});

test("formatCompletedLine: without kind/name still works (backward compat)", () => {
  const result = formatCompletedLine("  ", 0, 5, false);
  assert.equal(result, "✓ (5s)");
});

test("formatCompletedLine: nested indent preserved with kind/name (no color)", () => {
  const indent = "  · · ";
  const result = formatCompletedLine(indent, 0, 10, false, "rule", "ci_passes");
  assert.ok(result.startsWith("  · "));
  assert.ok(result.includes("✓ rule ci_passes (10s)"));
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

test("formatStartLine: shows backend name in prompt label when name differs from kind", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "Summarize the changes"],
  ];
  const result = formatStartLine("  ", "prompt", "cursor", false, params);
  assert.ok(result.includes("prompt cursor"));
  assert.ok(result.includes('"Summarize the changes"'));
});

test("formatStartLine: omits backend in prompt label when name equals kind", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "Summarize the changes"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // Should not have "prompt prompt"
  assert.ok(!result.includes("prompt prompt"));
});

test("sanitizeMultilineLogForTerminal: normalizes CR and strips embedded SGR", () => {
  assert.equal(
    sanitizeMultilineLogForTerminal('"Hi"\r\nMore'),
    '"Hi"\nMore',
  );
  assert.equal(
    sanitizeMultilineLogForTerminal('a\u001b[31mred\u001b[0mb'),
    "aredb",
  );
});

// === formatStartLine (color enabled) ===

test("formatStartLine: color enabled wraps marker with dim ANSI", () => {
  const result = formatStartLine("  ", "workflow", "deploy", true);
  assert.ok(result.includes("\u001b[2m▸\u001b[0m"), "marker should be dim");
});

test("formatStartLine: color enabled wraps kind with bold ANSI", () => {
  const result = formatStartLine("  ", "workflow", "deploy", true);
  assert.ok(result.includes("\u001b[1mworkflow\u001b[0m"), "kind should be bold");
});

test("formatStartLine: non-prompt kind with params shows dim param suffix", () => {
  const params: Array<[string, string]> = [
    ["repo", "/tmp/project"],
  ];
  const result = formatStartLine("  ", "workflow", "deploy", false, params);
  assert.ok(result.includes("deploy"));
  assert.ok(result.includes("repo"), "param key should appear");
});

test("formatStartLine: non-prompt kind with params and color enabled has dim suffix", () => {
  const params: Array<[string, string]> = [
    ["repo", "/tmp/project"],
  ];
  const result = formatStartLine("  ", "script", "build", true, params);
  assert.ok(result.includes("\u001b[2m"), "param suffix should be dim");
});

test("formatStartLine: prompt preview truncated beyond 24 chars", () => {
  const longText = "A".repeat(30);
  const params: Array<[string, string]> = [
    ["prompt_text", longText],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes("A".repeat(24) + "..."), "should truncate with ellipsis");
  assert.ok(!result.includes("A".repeat(25)), "should not contain full text");
});

test("formatStartLine: prompt preview at exactly 24 chars is not truncated", () => {
  const exactText = "B".repeat(24);
  const params: Array<[string, string]> = [
    ["prompt_text", exactText],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes(exactText), "exact-length preview should appear");
  assert.ok(!result.includes("..."), "should not have ellipsis");
});

// === sanitizeMultilineLogForTerminal (bare CR) ===

test("sanitizeMultilineLogForTerminal: normalizes bare CR to newline", () => {
  assert.equal(
    sanitizeMultilineLogForTerminal("progress\r50%\r100%"),
    "progress\n50%\n100%",
  );
});

// === formatHeartbeatLine ===

test("formatHeartbeatLine: formats kind name and running time (no dim)", () => {
  const result = formatHeartbeatLine("    ", "script", "build", 45, false);
  assert.equal(result, "  · script build (running 45s)");
});

test("formatHeartbeatLine: wraps in dim ANSI when dimEnabled", () => {
  const result = formatHeartbeatLine("    ", "script", "build", 10, true);
  assert.ok(result.startsWith("\u001b[2m"), "should start with dim");
  assert.ok(result.endsWith("\u001b[0m"), "should end with reset");
  assert.ok(result.includes("script build (running 10s)"));
});
