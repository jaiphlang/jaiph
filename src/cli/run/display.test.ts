import test from "node:test";
import assert from "node:assert/strict";
import {
  colorize,
  formatCompletedLine,
  formatHeartbeatLine,
  formatJaiphRunningBannerLines,
  formatStartLine,
  sanitizeMultilineLogForTerminal,
} from "./display";

// === formatJaiphRunningBannerLines ===

test("formatJaiphRunningBannerLines: no Docker shows no sandbox (no color)", () => {
  const s = formatJaiphRunningBannerLines("say_hello.jh", false, null, false);
  assert.equal(s, "\nJaiph: Running say_hello.jh (no sandbox)\n\n");
});

test("formatJaiphRunningBannerLines: Docker overlay shows fusefs locally (no color)", () => {
  const prev = process.env.CI;
  delete process.env.CI;
  try {
    const s = formatJaiphRunningBannerLines("say_hello.jh", true, "overlay", false);
    assert.equal(s, "\nJaiph: Running say_hello.jh (Docker sandbox, fusefs)\n\n");
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

test("formatJaiphRunningBannerLines: Docker copy shows tmp dir locally (no color)", () => {
  const prev = process.env.CI;
  delete process.env.CI;
  try {
    const s = formatJaiphRunningBannerLines("say_hello.jh", true, "copy", false);
    assert.equal(s, "\nJaiph: Running say_hello.jh (Docker sandbox, tmp dir)\n\n");
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

test("formatJaiphRunningBannerLines: CI obfuscates Docker sandbox detail", () => {
  const prev = process.env.CI;
  process.env.CI = "true";
  try {
    const s = formatJaiphRunningBannerLines("say_hello.jh", true, "overlay", false);
    assert.equal(s, "\nJaiph: Running say_hello.jh (Docker sandbox, …)\n\n");
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

test("formatJaiphRunningBannerLines: dim ANSI wraps parenthetical when color on", () => {
  const prev = process.env.CI;
  delete process.env.CI;
  try {
    const s = formatJaiphRunningBannerLines("x.jh", false, null, true);
    assert.ok(s.includes("\u001b[2m (no sandbox)\u001b[0m"));
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

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

// === formatStartLine: prompt preview escape handling ===

test("formatStartLine: prompt preview escapes backslashes", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "path\\to\\file"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes("\\\\"), "backslashes should be escaped");
});

test("formatStartLine: prompt preview passes through double quotes", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", 'say "hello"'],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes('"hello"'), "quotes should pass through");
  assert.ok(!result.includes('\\"'), "no backslash-quote escaping");
});

test("formatStartLine: prompt preview escapes backslash before quote", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", 'a\\"b'],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // The backslash should be doubled, and the quote should be escaped
  assert.ok(result.includes("\\\\"), "backslash should be escaped");
});

// === formatStartLine: multi-param prompt suffix rendering ===

test("formatStartLine: prompt with two params shows second as suffix", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "Analyze this"],
    ["schema", "{ type: string }"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes("Analyze this"), "preview should be shown");
  assert.ok(result.includes("schema"), "second param key should appear in suffix");
});

test("formatStartLine: prompt with only internal params shows no preview", () => {
  const params: Array<[string, string]> = [
    ["impl", "mymod::impl"],
    ["executor", "jaiph::prompt_impl"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // All values are internal (ends with ::impl or jaiph::prompt_impl), so no preview
  const quoteCount = (result.match(/"/g) || []).length;
  assert.equal(quoteCount, 0, "no quoted preview when all params are internal");
});

test("formatStartLine: prompt skips first param in suffix when it matches preview", () => {
  const params: Array<[string, string]> = [
    ["text", "Hello world"],
    ["extra", "more data"],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // "Hello world" should appear as the preview (in quotes)
  assert.ok(result.includes('"Hello world"'), "preview should be in quotes");
  // "extra" should appear in the suffix
  assert.ok(result.includes("extra"), "second param should appear in suffix");
});

// === formatStartLine: whitespace-only preview ===

test("formatStartLine: prompt with whitespace-only preview shows no quoted text", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "   "],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // After trim, oneLine is empty → no quoted preview
  const quoteCount = (result.match(/"/g) || []).length;
  assert.equal(quoteCount, 0, "no quoted preview for whitespace-only text");
});

// === formatStartLine: indent edge cases ===

test("formatStartLine: empty indent produces valid output", () => {
  const result = formatStartLine("", "workflow", "deploy", false);
  assert.ok(result.includes("workflow"), "kind should be present");
  assert.ok(result.includes("deploy"), "name should be present");
});

test("formatStartLine: single-char indent slices correctly", () => {
  const result = formatStartLine(" ", "script", "build", false);
  assert.ok(result.includes("script"), "kind should be present");
  assert.ok(result.includes("build"), "name should be present");
});

test("formatStartLine: prompt kind with no params falls through to else branch", () => {
  const result = formatStartLine("  ", "prompt", "prompt", false);
  // With no params, falls into else branch: kind === name → just "prompt" once
  const promptCount = (result.match(/prompt/g) || []).length;
  assert.equal(promptCount, 1, "should show 'prompt' exactly once");
  assert.ok(result.includes("▸"), "should have start marker");
});

test("formatStartLine: prompt kind with empty params array falls through to else branch", () => {
  const result = formatStartLine("  ", "prompt", "prompt", false, []);
  // Empty params array: condition `params.length > 0` is false → else branch
  const promptCount = (result.match(/prompt/g) || []).length;
  assert.equal(promptCount, 1, "should show 'prompt' exactly once");
});

test("formatStartLine: prompt kind with undefined params and different name", () => {
  const result = formatStartLine("  ", "prompt", "claude", false);
  // No params, kind !== name → shows "prompt claude"
  assert.ok(result.includes("prompt"), "kind should be present");
  assert.ok(result.includes("claude"), "name should be present");
});

// === formatCompletedLine: indent edge ===

test("formatCompletedLine: empty indent produces valid output", () => {
  const result = formatCompletedLine("", 0, 1, false, "workflow", "test");
  assert.ok(result.includes("✓"), "success marker should be present");
  assert.ok(result.includes("workflow test"), "kind and name should be present");
});

// === formatHeartbeatLine: empty indent ===

test("formatHeartbeatLine: empty indent produces valid output", () => {
  const result = formatHeartbeatLine("", "script", "build", 5, false);
  assert.ok(result.includes("script build"), "kind and name should be present");
  assert.ok(result.includes("running 5s"), "elapsed should be present");
});

// === PROMPT_ARGS_DISPLAY_MAX cap ===

test("formatStartLine: prompt param suffix respects 96-char cap", () => {
  const longValue = "V".repeat(100);
  const params: Array<[string, string]> = [
    ["prompt_text", "Hello"],
    ["context", longValue],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  // The suffix portion (after the preview) should be capped
  assert.ok(result.includes("Hello"), "preview should be shown");
  // Total suffix should not exceed PROMPT_ARGS_DISPLAY_MAX (96 chars)
  // The formatNamedParamsForDisplay call uses capTotalLength: 96
  const suffixStart = result.indexOf("context");
  if (suffixStart >= 0) {
    const suffix = result.slice(suffixStart - 2); // include " ("
    assert.ok(suffix.length <= 100, "suffix should be capped near 96 chars");
    assert.ok(suffix.includes("..."), "capped suffix should contain ellipsis");
  }
});

test("formatStartLine: prompt with many params gets suffix truncated", () => {
  const params: Array<[string, string]> = [
    ["prompt_text", "Analyze"],
    ["a", "A".repeat(30)],
    ["b", "B".repeat(30)],
    ["c", "C".repeat(30)],
  ];
  const result = formatStartLine("  ", "prompt", "prompt", false, params);
  assert.ok(result.includes("Analyze"), "preview should be present");
  // With 3 params of 30 chars each, the suffix must be truncated at 96
  assert.ok(result.includes("..."), "should have truncation ellipsis");
});

// --- formatStartLine: workflow/rule/script with params ---

test("formatStartLine: workflow with params shows param suffix (no color)", () => {
  const params: Array<[string, string]> = [["repo", "/home/user/project"]];
  const result = formatStartLine("  ", "workflow", "deploy", false, params);
  assert.ok(result.includes("workflow deploy"), "label present");
  assert.ok(result.includes("repo"), "param name in suffix");
});

test("formatStartLine: rule with params shows param suffix (no color)", () => {
  const params: Array<[string, string]> = [["threshold", "90"]];
  const result = formatStartLine("  ", "rule", "check_coverage", false, params);
  assert.ok(result.includes("rule check_coverage"), "label present");
  assert.ok(result.includes("threshold"), "param name in suffix");
});

test("formatStartLine: script kind does not show params when empty", () => {
  const result = formatStartLine("  ", "script", "deploy_impl", false, []);
  assert.ok(result.includes("script deploy_impl"), "label present");
  // Empty params array should not add trailing content
  assert.ok(!result.includes("("), "no param parens for empty params");
});

test("formatCompletedLine: nested indent with script kind and name (no color)", () => {
  const result = formatCompletedLine("      ", 0, 2.5, false, "script", "build_impl");
  assert.ok(result.includes("✓"), "success marker");
  assert.ok(result.includes("script build_impl"), "kind and name present");
  assert.ok(result.includes("2.5s"), "elapsed time present");
});
