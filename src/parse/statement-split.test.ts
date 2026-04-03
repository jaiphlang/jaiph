import test from "node:test";
import assert from "node:assert/strict";
import {
  expandBlockLineStatements,
  findClosingBraceIndex,
  shouldApplySemicolonStatementSplit,
  shouldSkipSemicolonSplitForLine,
  splitStatementsOnSemicolons,
  stripOneOuterBracePair,
} from "./statement-split";

test("stripOneOuterBracePair unwraps one balanced block", () => {
  assert.equal(stripOneOuterBracePair("{ run a; run b }"), "run a; run b");
  assert.equal(stripOneOuterBracePair("x { y }"), null);
});

test("splitStatementsOnSemicolons respects brace depth (subshell)", () => {
  assert.deepEqual(splitStatementsOnSemicolons("echo { a; b }"), ["echo { a; b }"]);
});

test("splitStatementsOnSemicolons splits at top level", () => {
  assert.deepEqual(splitStatementsOnSemicolons("run a; run b"), ["run a", "run b"]);
});

test("expandBlockLineStatements unwraps then splits", () => {
  assert.deepEqual(expandBlockLineStatements("{ run a; run b }"), ["run a", "run b"]);
});

test("shouldApplySemicolonStatementSplit keeps pure shell lines together", () => {
  assert.equal(shouldApplySemicolonStatementSplit(["echo a", "echo b"]), false);
  assert.equal(shouldApplySemicolonStatementSplit(["run a", "run b"]), true);
});

test("shouldSkipSemicolonSplitForLine detects bash if/then/fi", () => {
  assert.equal(shouldSkipSemicolonSplitForLine("  if ensure; then"), true);
  assert.equal(shouldSkipSemicolonSplitForLine("  fi"), true);
  assert.equal(shouldSkipSemicolonSplitForLine("run a; run b"), false);
});

test("findClosingBraceIndex finds matching close", () => {
  const s = 'workflow x() { run a; run b }';
  const open = s.indexOf("{");
  assert.equal(s[open], "{");
  const close = findClosingBraceIndex(s, open);
  assert.equal(s[close], "}");
  assert.equal(s.slice(open + 1, close), " run a; run b ");
});
