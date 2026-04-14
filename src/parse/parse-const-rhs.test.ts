import test from "node:test";
import assert from "node:assert/strict";
import { validateConstBashExpr, parseConstRhs } from "./const-rhs";

// === validateConstBashExpr ===

test("validateConstBashExpr: accepts simple string", () => {
  assert.doesNotThrow(() => validateConstBashExpr("test.jh", '"hello"', 1, 1));
});

test("validateConstBashExpr: accepts variable reference", () => {
  assert.doesNotThrow(() => validateConstBashExpr("test.jh", "$FOO", 1, 1));
});

test("validateConstBashExpr: rejects empty value", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "", 1, 1),
    /const value cannot be empty/,
  );
});

test("validateConstBashExpr: rejects whitespace-only value", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "   ", 1, 1),
    /const value cannot be empty/,
  );
});

test("validateConstBashExpr: rejects command substitution", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "$(echo hi)", 1, 1),
    /cannot use command substitution/,
  );
});

test("validateConstBashExpr: rejects embedded command substitution", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", 'prefix_$(cmd)_suffix', 1, 1),
    /cannot use command substitution/,
  );
});

test("validateConstBashExpr: rejects ${var%%} expansion", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${path%%/*}", 1, 1),
    /cannot use \$\{var%%\.\.\.\}/,
  );
});

test("validateConstBashExpr: rejects ${var//} expansion", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${str//old/new}", 1, 1),
    /cannot use \$\{var\/\/\.\.\.\}/,
  );
});

test("validateConstBashExpr: rejects ${#var}", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${#myVar}", 1, 1),
    /cannot use \$\{#var\}/,
  );
});

test("validateConstBashExpr: rejects ${var:-default} fallback", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${FOO:-default}", 1, 1),
    /shell fallback syntax/,
  );
});

test("validateConstBashExpr: rejects ${var:+value} fallback", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${FOO:+yes}", 1, 1),
    /shell fallback syntax/,
  );
});

test("validateConstBashExpr: rejects ${var:=value} fallback", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", "${FOO:=val}", 1, 1),
    /shell fallback syntax/,
  );
});

test("validateConstBashExpr: rejects ${var:?message} fallback", () => {
  assert.throws(
    () => validateConstBashExpr("test.jh", '${FOO:?missing}', 1, 1),
    /shell fallback syntax/,
  );
});

// === parseConstRhs ===

test("parseConstRhs: parses bash expression", () => {
  const result = parseConstRhs("test.jh", ['const x = "hello"'], 0, '"hello"', 1, 1, false, "x");
  assert.equal(result.value.kind, "expr");
  if (result.value.kind === "expr") {
    assert.equal(result.value.bashRhs, '"hello"');
  }
  assert.equal(result.nextLineIdx, 0);
});

test("parseConstRhs: parses run capture", () => {
  const result = parseConstRhs("test.jh", ["const x = run my_script()"], 0, "run my_script()", 1, 1, false, "x");
  assert.equal(result.value.kind, "run_capture");
  if (result.value.kind === "run_capture") {
    assert.equal(result.value.ref.value, "my_script");
  }
});

test("parseConstRhs: parses run capture with args", () => {
  const result = parseConstRhs("test.jh", ['const x = run my_script("arg")'], 0, 'run my_script("arg")', 1, 1, false, "x");
  assert.equal(result.value.kind, "run_capture");
  if (result.value.kind === "run_capture") {
    assert.equal(result.value.ref.value, "my_script");
    assert.equal(result.value.args, '"arg"');
  }
});

test("parseConstRhs: run without parens rejects (parens required)", () => {
  assert.throws(
    () => parseConstRhs("test.jh", ["const x = run my_script"], 0, "run my_script", 1, 1, false, "x"),
    /must target a valid reference/,
  );
});

test("parseConstRhs: parses ensure capture", () => {
  const result = parseConstRhs("test.jh", ["const x = ensure my_rule()"], 0, "ensure my_rule()", 1, 1, false, "x");
  assert.equal(result.value.kind, "ensure_capture");
  if (result.value.kind === "ensure_capture") {
    assert.equal(result.value.ref.value, "my_rule");
  }
});

test("parseConstRhs: ensure without parens rejects (parens required)", () => {
  assert.throws(
    () => parseConstRhs("test.jh", ["const x = ensure my_rule"], 0, "ensure my_rule", 1, 1, false, "x"),
    /must target a valid reference/,
  );
});

test("parseConstRhs: ensure with catch throws", () => {
  assert.throws(
    () => parseConstRhs("test.jh", ["const x = ensure my_rule() catch fail"], 0, "ensure my_rule() catch fail", 1, 1, false, "x"),
    /cannot use catch/,
  );
});

test("parseConstRhs: prompt in rule throws", () => {
  assert.throws(
    () => parseConstRhs("test.jh", ['const x = prompt "hello"'], 0, 'prompt "hello"', 1, 1, true, "x"),
    /not allowed in rules/,
  );
});

test("parseConstRhs: bare call without run suggests fix", () => {
  assert.throws(
    () => parseConstRhs("test.jh", ["const x = my_script()"], 0, "my_script()", 1, 1, false, "x"),
    /must use run/,
  );
});

test("parseConstRhs: parses prompt capture in workflow", () => {
  const lines = ['  const x = prompt "What is your name?"'];
  const result = parseConstRhs("test.jh", lines, 0, 'prompt "What is your name?"', 1, 1, false, "x");
  assert.equal(result.value.kind, "prompt_capture");
  if (result.value.kind === "prompt_capture") {
    assert.equal(result.value.raw, '"What is your name?"');
  }
});
