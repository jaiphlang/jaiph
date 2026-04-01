import test from "node:test";
import assert from "node:assert/strict";
import { parseFencedBlock } from "./fence";

test("fence: basic body extraction", () => {
  const lines = ["```", "line one", "line two", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "line one\nline two");
  assert.equal(result.lang, undefined);
  assert.equal(result.nextIdx, 4);
});

test("fence: single-line body", () => {
  const lines = ["```", "hello world", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "hello world");
  assert.equal(result.nextIdx, 3);
});

test("fence: empty body", () => {
  const lines = ["```", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "");
  assert.equal(result.nextIdx, 2);
});

test("fence: lang extraction", () => {
  const lines = ["```python3", "print('hi')", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "print('hi')");
  assert.equal(result.lang, "python3");
  assert.equal(result.nextIdx, 3);
});

test("fence: lang token with various values", () => {
  const lines = ["```node", "console.log(1)", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.lang, "node");
});

test("fence: fenceLineIdx not at start", () => {
  const lines = ["some preamble", "```bash", "echo hello", "```", "after"];
  const result = parseFencedBlock("test.jh", lines, 1);
  assert.equal(result.body, "echo hello");
  assert.equal(result.lang, "bash");
  assert.equal(result.nextIdx, 4);
});

test("fence: preserves indentation in body lines", () => {
  const lines = ["```", "  indented", "    more", "```"];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "  indented\n    more");
});

test("fence: error on unterminated fence", () => {
  const lines = ["```", "body", "no closing"];
  assert.throws(
    () => parseFencedBlock("test.jh", lines, 0),
    /unterminated fenced block/,
  );
});

test("fence: error on text after opening backticks that isn't single token", () => {
  const lines = ["```python3 extra", "body", "```"];
  assert.throws(
    () => parseFencedBlock("test.jh", lines, 0),
    /invalid opening fence/,
  );
});

test("fence: error on invalid content on closing fence line", () => {
  const lines = ["```", "body", "``` extra"];
  assert.throws(
    () => parseFencedBlock("test.jh", lines, 0),
    /closing fence must be exactly/,
  );
});

test("fence: closing line may include returns schema on same line as ```", () => {
  const lines = ['```', "body", '``` returns "{ role: string }"'];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "body");
  assert.equal(result.returns, "{ role: string }");
  assert.equal(result.nextIdx, 3);
});

test("fence: same-line returns with lang on opening fence", () => {
  const lines = ["```text", "x", '``` returns "{ n: number }"'];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "x");
  assert.equal(result.lang, "text");
  assert.equal(result.returns, "{ n: number }");
});

test("fence: closing fence with surrounding whitespace is accepted", () => {
  const lines = ["```", "body", "  ```  "];
  const result = parseFencedBlock("test.jh", lines, 0);
  assert.equal(result.body, "body");
  assert.equal(result.nextIdx, 3);
});
