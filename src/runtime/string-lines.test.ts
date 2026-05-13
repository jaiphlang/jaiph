import assert from "node:assert/strict";
import test from "node:test";
import { linesOfDelimitedString } from "./string-lines";

test("linesOfDelimitedString: empty", () => {
  assert.deepEqual(linesOfDelimitedString(""), []);
});

test("linesOfDelimitedString: no trailing newline", () => {
  assert.deepEqual(linesOfDelimitedString("a"), ["a"]);
  assert.deepEqual(linesOfDelimitedString("a\nb"), ["a", "b"]);
});

test("linesOfDelimitedString: trailing newline drops empty last segment", () => {
  assert.deepEqual(linesOfDelimitedString("a\n"), ["a"]);
  assert.deepEqual(linesOfDelimitedString("a\nb\n"), ["a", "b"]);
});

test("linesOfDelimitedString: normalizes CRLF", () => {
  assert.deepEqual(linesOfDelimitedString("a\r\nb"), ["a", "b"]);
});

test("linesOfDelimitedString: preserves empty interior lines", () => {
  assert.deepEqual(linesOfDelimitedString("a\n\nb"), ["a", "", "b"]);
});
