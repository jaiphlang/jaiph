import test from "node:test";
import assert from "node:assert/strict";
import { parseTestBlock } from "./tests";

// === parseTestBlock: header ===

test("parseTestBlock: parses basic test block header", () => {
  const lines = [
    'test "my test" {',
    '  run lib.greet()',
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
    '  run lib.greet()',
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

test("parseTestBlock: rejects mock prompt with single-quoted string", () => {
  const lines = [
    'test "t1" {',
    "  mock prompt 'response text'",
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /single-quoted strings are not supported/,
  );
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

test("parseTestBlock: parses mock workflow block with parens", () => {
  const lines = [
    'test "t1" {',
    '  mock workflow lib.greet() {',
    '    return "mocked"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 1);
  assert.equal(testBlock.steps[0].type, "test_mock_workflow");
  if (testBlock.steps[0].type === "test_mock_workflow") {
    assert.equal(testBlock.steps[0].ref, "lib.greet");
    assert.deepEqual(testBlock.steps[0].params, []);
    assert.equal(testBlock.steps[0].steps.length, 1);
  }
});

test("parseTestBlock: parses mock workflow with named params", () => {
  const lines = [
    'test "t1" {',
    '  mock workflow lib.deploy(target, version) {',
    '    log "mock deploy"',
    '    return "deployed"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_mock_workflow") {
    assert.deepEqual(testBlock.steps[0].params, ["target", "version"]);
    assert.equal(testBlock.steps[0].steps.length, 2);
  }
});

test("parseTestBlock: parses mock rule block with parens", () => {
  const lines = [
    'test "t1" {',
    '  mock rule lib.check() {',
    '    return "ok"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_mock_rule");
  if (testBlock.steps[0].type === "test_mock_rule") {
    assert.deepEqual(testBlock.steps[0].params, []);
  }
});

test("parseTestBlock: parses mock script block with parens", () => {
  const lines = [
    'test "t1" {',
    '  mock script my_script() {',
    '    echo hi',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_mock_script");
  if (testBlock.steps[0].type === "test_mock_script") {
    assert.equal(testBlock.steps[0].ref, "my_script");
    assert.deepEqual(testBlock.steps[0].params, []);
  }
});

test("parseTestBlock: mock script with named params", () => {
  const lines = [
    'test "t1" {',
    '  mock script lib.helper(dir) {',
    '    echo "a.ts"',
    '  }',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_mock_script") {
    assert.deepEqual(testBlock.steps[0].params, ["dir"]);
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

test("parseTestBlock: rejects mock workflow without parens", () => {
  const lines = [
    'test "t1" {',
    '  mock workflow lib.greet {',
    '    return "mocked"',
    '  }',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /mock workflow requires parentheses/,
  );
});

test("parseTestBlock: rejects mock rule without parens", () => {
  const lines = [
    'test "t1" {',
    '  mock rule lib.check {',
    '    return "ok"',
    '  }',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /mock rule requires parentheses/,
  );
});

test("parseTestBlock: rejects mock script without parens", () => {
  const lines = [
    'test "t1" {',
    '  mock script lib.helper {',
    '    echo hi',
    '  }',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /mock script requires parentheses/,
  );
});

// === parseTestBlock: assertions (snake_case) ===

test("parseTestBlock: parses expect_contain", () => {
  const lines = [
    'test "t1" {',
    '  expect_contain result "expected text"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_contain");
  if (testBlock.steps[0].type === "test_expect_contain") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].substring, "expected text");
  }
});

test("parseTestBlock: parses expect_not_contain", () => {
  const lines = [
    'test "t1" {',
    '  expect_not_contain result "bad text"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_not_contain");
  if (testBlock.steps[0].type === "test_expect_not_contain") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].substring, "bad text");
  }
});

test("parseTestBlock: parses expect_equal", () => {
  const lines = [
    'test "t1" {',
    '  expect_equal result "exact value"',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_expect_equal");
  if (testBlock.steps[0].type === "test_expect_equal") {
    assert.equal(testBlock.steps[0].variable, "result");
    assert.equal(testBlock.steps[0].expected, "exact value");
  }
});

test("parseTestBlock: rejects old camelCase expectContain", () => {
  const lines = [
    'test "t1" {',
    '  expectContain result "text"',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /camelCase assertions are no longer supported/,
  );
});

test("parseTestBlock: rejects old camelCase expectEqual", () => {
  const lines = [
    'test "t1" {',
    '  expectEqual result "text"',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /camelCase assertions are no longer supported/,
  );
});

// === parseTestBlock: workflow execution (new syntax) ===

test("parseTestBlock: parses const capture with run", () => {
  const lines = [
    'test "t1" {',
    '  const result = run lib.greet()',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_run_workflow");
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].captureName, "result");
    assert.equal(testBlock.steps[0].workflowRef, "lib.greet");
  }
});

test("parseTestBlock: parses const capture with run and args", () => {
  const lines = [
    'test "t1" {',
    '  const result = run lib.greet("world")',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.deepEqual(testBlock.steps[0].args, ["world"]);
  }
});

test("parseTestBlock: parses const capture with allow_failure", () => {
  const lines = [
    'test "t1" {',
    '  const result = run lib.greet() allow_failure',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].allowFailure, true);
  }
});

test("parseTestBlock: parses run without capture", () => {
  const lines = [
    'test "t1" {',
    '  run lib.greet()',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps[0].type, "test_run_workflow");
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.equal(testBlock.steps[0].workflowRef, "lib.greet");
    assert.equal(testBlock.steps[0].captureName, undefined);
  }
});

test("parseTestBlock: parses run with args", () => {
  const lines = [
    'test "t1" {',
    '  run lib.greet("Alice")',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.deepEqual(testBlock.steps[0].args, ["Alice"]);
  }
});

test("parseTestBlock: parses run with multiple args", () => {
  const lines = [
    'test "t1" {',
    '  run lib.deploy("prod", "v2")',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  if (testBlock.steps[0].type === "test_run_workflow") {
    assert.deepEqual(testBlock.steps[0].args, ["prod", "v2"]);
  }
});

// === parseTestBlock: old syntax rejection ===

test("parseTestBlock: rejects bare assignment without const/run", () => {
  const lines = [
    'test "t1" {',
    '  result = lib.greet',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /use "const/,
  );
});

test("parseTestBlock: rejects bare workflow call without run", () => {
  const lines = [
    'test "t1" {',
    '  lib.greet',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /use "run/,
  );
});

test("parseTestBlock: unrecognized line is E_PARSE", () => {
  const lines = [
    'test "t1" {',
    '  echo "hello world"',
    '}',
  ];
  assert.throws(
    () => parseTestBlock("test.jh", lines, 0),
    /unrecognized test step/,
  );
});

// === parseTestBlock: comments and empty lines ===

test("parseTestBlock: preserves comments and blank lines as steps", () => {
  const lines = [
    'test "t1" {',
    '',
    '  # this is a comment',
    '  run lib.greet()',
    '',
    '}',
  ];
  const { testBlock } = parseTestBlock("test.jh", lines, 0);
  assert.equal(testBlock.steps.length, 3);
  assert.equal(testBlock.steps[0].type, "comment");
  assert.equal(testBlock.steps[1].type, "test_run_workflow");
  assert.equal(testBlock.steps[2].type, "blank_line");
});

// === parseTestBlock: multiple steps ===

test("parseTestBlock: parses multiple steps", () => {
  const lines = [
    'test "multi" {',
    '  mock prompt "yes"',
    '  const result = run lib.ask()',
    '  expect_contain result "yes"',
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
