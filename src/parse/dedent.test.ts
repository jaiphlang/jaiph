import test from "node:test";
import assert from "node:assert/strict";
import { dedentCommonLeadingWhitespace } from "./dedent";

test("dedent: empty and whitespace-only blocks", () => {
  assert.equal(dedentCommonLeadingWhitespace(""), "");
  assert.equal(dedentCommonLeadingWhitespace("\n\n"), "\n\n");
});

test("dedent: uniform margin", () => {
  const input = "    line1\n    line2";
  assert.equal(dedentCommonLeadingWhitespace(input), "line1\nline2");
});

test("dedent: relative indentation preserved", () => {
  const input = "  a\n    b";
  assert.equal(dedentCommonLeadingWhitespace(input), "a\n  b");
});

test("dedent: blank lines do not affect margin", () => {
  const input = "  x\n\n  y";
  assert.equal(dedentCommonLeadingWhitespace(input), "x\n\ny");
});
