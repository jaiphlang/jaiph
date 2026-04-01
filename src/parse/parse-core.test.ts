import test from "node:test";
import assert from "node:assert/strict";
import {
  stripQuotes,
  isRef,
  hasUnescapedClosingQuote,
  indexOfClosingDoubleQuote,
  colFromRaw,
  braceDepthDelta,
  fail,
} from "./core";

// === stripQuotes ===

test("stripQuotes: removes double quotes from a quoted string", () => {
  assert.equal(stripQuotes('"hello"'), "hello");
});

test("stripQuotes: does not strip single quotes (double quotes only)", () => {
  assert.equal(stripQuotes("'hello'"), "'hello'");
});

test("stripQuotes: trims whitespace before checking quotes", () => {
  assert.equal(stripQuotes('  "spaced"  '), "spaced");
});

test("stripQuotes: returns trimmed value when not quoted", () => {
  assert.equal(stripQuotes("  bare  "), "bare");
});

test("stripQuotes: returns trimmed value for mismatched quotes", () => {
  assert.equal(stripQuotes(`"mismatched'`), `"mismatched'`);
});

test("stripQuotes: returns empty string for empty quoted string", () => {
  assert.equal(stripQuotes('""'), "");
});

test("stripQuotes: returns trimmed value for single character", () => {
  assert.equal(stripQuotes("x"), "x");
});

test("stripQuotes: returns empty string for empty input", () => {
  assert.equal(stripQuotes(""), "");
});

// === isRef ===

test("isRef: accepts simple identifier", () => {
  assert.equal(isRef("my_rule"), true);
});

test("isRef: accepts dotted identifier", () => {
  assert.equal(isRef("mod.rule_name"), true);
});

test("isRef: rejects identifier starting with number", () => {
  assert.equal(isRef("1bad"), false);
});

test("isRef: rejects triple-dotted path", () => {
  assert.equal(isRef("a.b.c"), false);
});

test("isRef: rejects empty string", () => {
  assert.equal(isRef(""), false);
});

test("isRef: rejects string with spaces", () => {
  assert.equal(isRef("has space"), false);
});

test("isRef: accepts underscore-only identifier", () => {
  assert.equal(isRef("_"), true);
});

// === hasUnescapedClosingQuote ===

test("hasUnescapedClosingQuote: finds unescaped quote", () => {
  assert.equal(hasUnescapedClosingQuote('hello"world', 0), true);
});

test("hasUnescapedClosingQuote: skips escaped quote", () => {
  assert.equal(hasUnescapedClosingQuote('hello\\"end', 0), false);
});

test("hasUnescapedClosingQuote: treats backslash-quote as escaped via simple check", () => {
  // The implementation uses text[i-1] !== "\\" which treats \\" as escaped.
  // In JS string 'ab\\\\"cd', the chars are: a b \ \ " c d
  // At index 4 (the "), text[3] is "\\" so it's treated as escaped.
  assert.equal(hasUnescapedClosingQuote('ab\\\\"cd', 0), false);
});

test("hasUnescapedClosingQuote: returns false for empty string", () => {
  assert.equal(hasUnescapedClosingQuote("", 0), false);
});

test("hasUnescapedClosingQuote: respects startIndex", () => {
  assert.equal(hasUnescapedClosingQuote('"only at start"', 1), true);
});

// === indexOfClosingDoubleQuote ===

test("indexOfClosingDoubleQuote: returns index of unescaped quote", () => {
  assert.equal(indexOfClosingDoubleQuote('abc"def', 0), 3);
});

test("indexOfClosingDoubleQuote: skips escaped quote", () => {
  assert.equal(indexOfClosingDoubleQuote('abc\\"def"end', 0), 8);
});

test("indexOfClosingDoubleQuote: returns -1 when no closing quote", () => {
  assert.equal(indexOfClosingDoubleQuote("no quote here", 0), -1);
});

test("indexOfClosingDoubleQuote: respects startIndex", () => {
  assert.equal(indexOfClosingDoubleQuote('"skip"find"', 6), 10);
});

// === colFromRaw ===

test("colFromRaw: returns 1 for no leading whitespace", () => {
  assert.equal(colFromRaw("hello"), 1);
});

test("colFromRaw: returns column after leading spaces", () => {
  assert.equal(colFromRaw("    hello"), 5);
});

test("colFromRaw: returns 1 for empty string", () => {
  assert.equal(colFromRaw(""), 1);
});

// === braceDepthDelta ===

test("braceDepthDelta: returns 0 for no braces", () => {
  assert.equal(braceDepthDelta("hello world"), 0);
});

test("braceDepthDelta: returns 1 for opening brace", () => {
  assert.equal(braceDepthDelta("func {"), 1);
});

test("braceDepthDelta: returns -1 for closing brace", () => {
  assert.equal(braceDepthDelta("}"), -1);
});

test("braceDepthDelta: returns 0 for balanced braces", () => {
  assert.equal(braceDepthDelta("{ x }"), 0);
});

test("braceDepthDelta: handles nested braces", () => {
  assert.equal(braceDepthDelta("{{ inner }}"), 0);
});

test("braceDepthDelta: returns positive for multiple opens", () => {
  assert.equal(braceDepthDelta("{ {"), 2);
});

// === fail ===

test("fail: throws jaiphError with E_PARSE in message", () => {
  assert.throws(
    () => fail("test.jh", "bad input", 5, 3),
    (err: any) => err.message.includes("E_PARSE") && err.message.includes("bad input") && err.message.includes("test.jh:5:3"),
  );
});
