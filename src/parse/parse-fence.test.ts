import test from "node:test";
import assert from "node:assert/strict";
import { readFencedScript } from "./triple-quote";

/** Read the `'''` block that opens on line `idx`. */
function readFence(lines: string[], idx: number) {
  return readFencedScript("test.jh", lines, idx, lines[idx]!);
}

test("fence: basic body extraction", () => {
  const lines = ["'''", "line one", "line two", "'''"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "line one\nline two");
  assert.equal(result.nextIdx, 4);
});

test("fence: single-line body", () => {
  const lines = ["'''", "hello world", "'''"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "hello world");
  assert.equal(result.nextIdx, 3);
});

test("fence: empty body", () => {
  const lines = ["'''", "'''"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "");
  assert.equal(result.nextIdx, 2);
});

test("fence: tag after the opening quotes is rejected with a fix-it", () => {
  const lines = ["'''python3", "print('hi')", "'''"];
  assert.throws(
    () => readFence(lines, 0),
    /interpreter tags go before the opening quotes: python3'''\.\.\.''' \(not '''python3\)/,
  );
});

test("fence: fenceLineIdx not at start", () => {
  const lines = ["some preamble", "'''", "echo hello", "'''", "after"];
  const result = readFence(lines, 1);
  assert.equal(result.body, "echo hello");
  assert.equal(result.nextIdx, 4);
});

test("fence: body keeps indentation relative to its margin", () => {
  const lines = ["'''", "  indented", "    more", "'''"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "indented\n  more");
});

test("fenced script block: dedents common leading whitespace", () => {
  const lines = [
    "'''",
    "  line1",
    "    line2",
    "  cat <<'EOF'",
    "  content",
    "  EOF",
    "'''",
  ];
  const result = readFence(lines, 0);
  assert.equal(result.body, "line1\n  line2\ncat <<'EOF'\ncontent\nEOF");
});

test("fenced script block: uniform margin is removed", () => {
  const lines = ["'''", "  import sys", "  print(sys.argv[1])", "'''"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "import sys\nprint(sys.argv[1])");
});

test("fence: error on unterminated fence", () => {
  const lines = ["'''", "body", "no closing"];
  assert.throws(
    () => readFence(lines, 0),
    /unterminated fenced block/,
  );
});

test("fence: error on other text after the opening quotes", () => {
  const lines = ["'''python3 extra", "body", "'''"];
  assert.throws(
    () => readFence(lines, 0),
    /invalid opening fence/,
  );
});

test("fence: trailing content on closing fence is returned via afterClose", () => {
  const lines = ["'''", "body", "''' extra"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "body");
  assert.equal(result.afterClose, " extra");
});

test("fence: closing line may include returns schema on same line as '''", () => {
  const lines = ["'''", "body", "''' returns \"{ role: string }\""];
  const result = readFence(lines, 0);
  assert.equal(result.body, "body");
  assert.equal(result.afterClose, ' returns "{ role: string }"');
  assert.equal(result.nextIdx, 3);
});

test("fence: same-line trailing content after the closing fence", () => {
  const lines = ["'''", "x", "''' (args)"];
  const result = readFence(lines, 0);
  assert.equal(result.body, "x");
  assert.equal(result.afterClose, " (args)");
});

test("fence: triple-backtick opener is rejected", () => {
  const lines = ["```", "body", "```"];
  assert.throws(
    () => readFence(lines, 0),
    /script bodies use triple single quotes/,
  );
});

test("fence: closing fence with surrounding whitespace is accepted", () => {
  const lines = ["'''", "body", "  '''  "];
  const result = readFence(lines, 0);
  assert.equal(result.body, "body");
  assert.equal(result.nextIdx, 3);
});
