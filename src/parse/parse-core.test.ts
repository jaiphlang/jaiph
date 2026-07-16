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
  parseCallRef,
  isBareIdentifier,
  isBareDottedIdentifier,
  isJaiphInterpolationRef,
  argsToRuntimeString,
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

// === isBareIdentifier ===

test("isBareIdentifier: accepts simple identifier", () => {
  assert.equal(isBareIdentifier("task"), true);
});

test("isBareIdentifier: accepts underscore-prefixed identifier", () => {
  assert.equal(isBareIdentifier("_result"), true);
});

test("isBareIdentifier: rejects keyword 'run'", () => {
  assert.equal(isBareIdentifier("run"), false);
});

test("isBareIdentifier: rejects keyword 'ensure'", () => {
  assert.equal(isBareIdentifier("ensure"), false);
});

test("isBareIdentifier: rejects keyword 'const'", () => {
  assert.equal(isBareIdentifier("const"), false);
});

test("isBareIdentifier: rejects string starting with digit", () => {
  assert.equal(isBareIdentifier("3abc"), false);
});

test("isBareIdentifier: rejects string with spaces", () => {
  assert.equal(isBareIdentifier("has space"), false);
});

// === parseCallRef: typed Arg[] classification ===

test("parseCallRef: bare identifier becomes var arg", () => {
  const result = parseCallRef("foo(task)");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "var", name: "task" }]);
});

test("parseCallRef: bare identifier mixed with quoted arg", () => {
  const result = parseCallRef('foo(task, "hello")');
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [
    { kind: "var", name: "task" },
    { kind: "literal", raw: '"hello"' },
  ]);
});

test("parseCallRef: multiple bare identifiers", () => {
  const result = parseCallRef("foo(task, branch_name)");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [
    { kind: "var", name: "task" },
    { kind: "var", name: "branch_name" },
  ]);
});

test("parseCallRef: keyword arg is stored as literal (not var)", () => {
  const result = parseCallRef("foo(run)");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "literal", raw: "run" }]);
});

test("parseCallRef: quoted string arg is stored as literal", () => {
  const result = parseCallRef('foo("task")');
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "literal", raw: '"task"' }]);
});

test("parseCallRef: ${var} interpolation arg is stored as literal", () => {
  const result = parseCallRef("foo(${task})");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "literal", raw: "${task}" }]);
});

test("parseCallRef: bare dotted IDENT.IDENT becomes var arg", () => {
  const result = parseCallRef("foo(result.role)");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "var", name: "result.role" }]);
});

test("parseCallRef: ${var.field} interpolation arg is stored as literal", () => {
  const result = parseCallRef("foo(${result.role})");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.deepEqual(result.args, [{ kind: "literal", raw: "${result.role}" }]);
});

test("argsToRuntimeString: dotted var becomes ${base.field}", () => {
  assert.equal(argsToRuntimeString([{ kind: "var", name: "result.role" }]), "${result.role}");
});

test("isBareDottedIdentifier: accepts base.field", () => {
  assert.equal(isBareDottedIdentifier("result.role"), true);
  assert.equal(isBareDottedIdentifier("result"), false);
  assert.equal(isBareDottedIdentifier("a.b.c"), false);
});

test("parseCallRef: no args returns undefined args", () => {
  const result = parseCallRef("foo()");
  assert.ok(result);
  assert.equal(result.ref, "foo");
  assert.equal(result.args, undefined);
});

// === parseCallRef: bare identifier (no parens) — now returns null ===

test("parseCallRef: bare identifier returns null (parens required)", () => {
  assert.equal(parseCallRef("setup"), null);
});

test("parseCallRef: bare dotted identifier returns null (parens required)", () => {
  assert.equal(parseCallRef("lib.setup"), null);
});

test("parseCallRef: bare identifier with trailing content returns null", () => {
  assert.equal(parseCallRef("setup extra"), null);
});

test("parseCallRef: bare identifier followed by { returns null (definition, not call)", () => {
  assert.equal(parseCallRef("setup {"), null);
});

test("parseCallRef: bare identifier followed by { with content returns null", () => {
  assert.equal(parseCallRef("setup { body }"), null);
});

test("parseCallRef: bare identifier starting with digit returns null", () => {
  const result = parseCallRef("123bad");
  assert.equal(result, null);
});

// === isJaiphInterpolationRef ===

test("isJaiphInterpolationRef: accepts ${name}", () => {
  assert.equal(isJaiphInterpolationRef("${model}"), true);
});

test("isJaiphInterpolationRef: accepts ${name.field}", () => {
  assert.equal(isJaiphInterpolationRef("${model.field}"), true);
});

test("isJaiphInterpolationRef: rejects unclosed ${model", () => {
  assert.equal(isJaiphInterpolationRef("${model"), false);
});

test("isJaiphInterpolationRef: rejects shell fallback ${model:-x}", () => {
  assert.equal(isJaiphInterpolationRef("${model:-x}"), false);
});

test("isJaiphInterpolationRef: rejects bare identifier (no braces)", () => {
  assert.equal(isJaiphInterpolationRef("model"), false);
});

test("isJaiphInterpolationRef: rejects ${#var} length form", () => {
  assert.equal(isJaiphInterpolationRef("${#model}"), false);
});

test("isJaiphInterpolationRef: rejects ${var//} substitution form", () => {
  assert.equal(isJaiphInterpolationRef("${model//old/new}"), false);
});
