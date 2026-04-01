import test from "node:test";
import assert from "node:assert/strict";
import { parseTestBlock } from "./tests";

// === parseTestBlock: header ===

test("parseTestBlock: parses basic test block header", () => {
  const lines = [
    'test "my test" {',
    '  echo hello',
    '}',
  ];
  const { testBlock, nextIndex } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.description, "my test");
  assert.equal(testBlock.loc.line, 1);
  assert.equal(nextIndex, 3);
});

test("parseTestBlock: rejects malformed header", () => {
  const lines = ["test missing_brace"];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /test block must match/,
  );
});

test("parseTestBlock: unterminated block throws", () => {
  const lines = [
    'test "open" {',
    '  echo hello',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /unterminated test block/,
  );
});

// === parseTestBlock: mock prompt (simple) ===

test("parseTestBlock: parses mock prompt with double-quoted string", () => {
  const lines = [
    'test "t1" {',
    '  mock prompt "response text"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_mock_prompt");
  if (testBlock.steps[0].type === "test_mock_prompt") {
    assert.equal(testBlock.steps[0].response, "response text");
  }
});

test("parseTestBlock: parses mock prompt with single-quoted string", () => {
  const lines = [
    'test "t1" {',
    "  mock prompt 'response text'",
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_mock_prompt");
  if (testBlock.steps[0].type === "test_mock_prompt") {
    assert.equal(testBlock.steps[0].response, "response text");
  }
});

// === parseTestBlock: mock prompt block (match arms) ===

test("parseTestBlock: parses mock prompt block with string literal and wildcard", () => {
  const lines = [
    'test "t1" {',
    '  mock prompt {',
    '    "hello" => "world"',
    '    _ => "default"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_mock_prompt_block");
  if (testBlock.steps[0].type === "test_mock_prompt_block") {
    assert.equal(testBlock.steps[0].arms.length, 2);
    assert.deepEqual(testBlock.steps[0].arms[0].pattern, { kind: "string_literal", value: "hello" });
    assert.equal(testBlock.steps[0].arms[0].body, '"world"');
    assert.deepEqual(testBlock.steps[0].arms[1].pattern, { kind: "wildcard" });
    assert.equal(testBlock.steps[0].arms[1].body, '"default"');
  }
});

test("parseTestBlock: parses mock prompt block with regex and multiple arms", () => {
  const lines = [
    'test "t1" {',
    '  mock prompt {',
    '    "a" => "ra"',
    '    /b+/ => "rb"',
    '    _ => "default"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_mock_prompt_block");
  if (testBlock.steps[0].type === "test_mock_prompt_block") {
    assert.equal(testBlock.steps[0].arms.length, 3);
    assert.deepEqual(testBlock.steps[0].arms[0].pattern, { kind: "string_literal", value: "a" });
    assert.deepEqual(testBlock.steps[0].arms[1].pattern, { kind: "regex", source: "b+" });
    assert.deepEqual(testBlock.steps[0].arms[2].pattern, { kind: "wildcard" });
  }
});

// === parseTestBlock: mock symbol blocks ===

test("parseTestBlock: parses mock workflow block", () => {
  const lines = [
    'test "t1" {',
    '  mock workflow lib.greet {',
    '    echo mocked',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_mock_workflow");
  if (testBlock.steps[0].type === "test_mock_workflow") {
    assert.equal(testBlock.steps[0].ref, "lib.greet");
  }
});

test("parseTestBlock: parses mock rule block", () => {
  const lines = [
    'test "t1" {',
    '  mock rule lib.check {',
    '    exit 0',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_mock_rule");
});

test("parseTestBlock: parses mock script block", () => {
  const lines = [
    'test "t1" {',
    '  mock script my_script {',
    '    echo hi',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_mock_script");
  if (testBlock.steps[0].type === "test_mock_script") {
    assert.equal(testBlock.steps[0].ref, "my_script");
  }
});

test("parseTestBlock: rejects mock function (legacy)", () => {
  const lines = [
    'test "t1" {',
    '  mock function my_func {',
    '  }',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /mock function.*no longer supported/,
  );
});

// === parseTestBlock: assertions ===

test("parseTestBlock: parses expectContain", () => {
  const lines = [
    'test "t1" {',
    '  expectContain result "expected text"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_contain");
  if (testBlock.steps[0].type === "test_expect_contain") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].substring, "expected text");
  }
});

test("parseTestBlock: parses expectNotContain", () => {
  const lines = [
    'test "t1" {',
    '  expectNotContain result "bad text"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_not_contain");
  if (testBlock.steps[0].type === "test_expect_not_contain") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].substring, "bad text");
  }
});

test("parseTestBlock: parses expectEqual", () => {
  const lines = [
    'test "t1" {',
    '  expectEqual result "exact value"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_equal");
  if (testBlock.steps[0].type === "test_expect_equal") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].expected, "exact value");
  }
});

// === parseTestBlock: workflow execution ===

test("parseTestBlock: parses assignment with workflow ref", () => {
  const lines = [
    'test "t1" {',
    '  result = lib.greet',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_run_workflow");
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].captureName, "result");
    assert.equal(testBlock.steps[0].workflowRef, "lib.greet");
  }
});

test("parseTestBlock: parses assignment with args", () => {
  const lines = [
    'test "t1" {',
    '  result = lib.greet "world"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.deepEqual(testBlock.steps[0].args, ["world"]);
  }
});

test("parseTestBlock: parses assignment with allow_failure", () => {
  const lines = [
    'test "t1" {',
    '  result = lib.greet allow_failure',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].allowFailure, true);
  }
});

test("parseTestBlock: parses direct workflow call", () => {
  const lines = [
    'test "t1" {',
    '  lib.greet',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_run_workflow");
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].workflowRef, "lib.greet");
    assert.equal(testBlock.steps[0].captureName, undefined);
  }
});

test("parseTestBlock: parses capture with ignore failure pattern", () => {
  const lines = [
    'test "t1" {',
    '  out=$({ lib.greet 2>&1; } || true )',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_run_workflow");
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].captureName, "out");
    assert.equal(testBlock.steps[0].workflowRef, "lib.greet");
    assert.equal(testBlock.steps[0].allowFailure, true);
  }
});

// === parseTestBlock: shell fallback ===

test("parseTestBlock: unrecognized line becomes shell step", () => {
  const lines = [
    'test "t1" {',
    '  echo "hello world"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_shell");
  if (testBlock.steps[0].type === "test_shell") {
    assert.equal(testBlock.steps[0].command, '  echo "hello world"');
  }
});

// === parseTestBlock: comments and empty lines ===

test("parseTestBlock: skips comments and empty lines", () => {
  const lines = [
    'test "t1" {',
    '',
    '  # this is a comment',
    '  echo hello',
    '',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_shell");
});

// === parseTestBlock: multiple steps ===

test("parseTestBlock: parses multiple steps", () => {
  const lines = [
    'test "multi" {',
    '  mock prompt "yes"',
    '  result = lib.ask',
    '  expectContain result "yes"',
    '}',
  ];
  const { testBlock, nextIndex } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 3);
  assert.equal(testBlock.steps[0].type, "test_mock_prompt");
  assert.equal(testBlock.steps[1].type, "test_run_workflow");
  assert.equal(testBlock.steps[2].type, "test_expect_contain");
  assert.equal(nextIndex, 5);
});

// === parseTestBlock: escaped description ===

test("parseTestBlock: handles escaped quotes in description", () => {
  const lines = [
    'test "test \\"quoted\\" name" {',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.description, 'test "quoted" name');
});
