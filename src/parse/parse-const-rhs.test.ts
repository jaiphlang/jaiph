import test from "node:test";
import assert from "node:assert/strict";
import { validateConstBashExpr, parseConstRhs } from "./const-rhs";
import { BodyCursor } from "./body-cursor";

/** The cursor over `lines` and the position of 0-based line `idx`. */
function src(lines: string[], idx: number, filePath = "test.jh"): [BodyCursor, number] {
  return [BodyCursor.of(filePath, lines.join("\n")), lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0)];
}

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

test("parseConstRhs: parses literal expression", () => {
  const result = parseConstRhs(...src(['const x = "hello"'], 0), '"hello"', 1, 1, "x");
  assert.equal(result.value.kind, "literal");
  if (result.value.kind === "literal") {
    assert.equal(result.value.raw, '"hello"');
  }
  assert.equal(result.next, src(['const x = "hello"'], 1)[1]);
});

test("parseConstRhs: bare identifier is sugar for interpolated literal", () => {
  const result = parseConstRhs(...src(["const x = response"], 0), "response", 1, 1, "x");
  assert.equal(result.value.kind, "literal");
  if (result.value.kind === "literal") {
    assert.equal(result.value.raw, '"${response}"');
  }
});

test("parseConstRhs: bare dotted identifier is sugar for interpolated literal", () => {
  const result = parseConstRhs(...src(["const x = response.message"], 0), "response.message", 1, 1, "x");
  assert.equal(result.value.kind, "literal");
  if (result.value.kind === "literal") {
    assert.equal(result.value.raw, '"${response.message}"');
  }
});

test("parseConstRhs: parses run capture as Expr.call", () => {
  const result = parseConstRhs(...src(["const x = my_script()"], 0), "my_script()", 1, 1, "x");
  assert.equal(result.value.kind, "call");
  if (result.value.kind === "call") {
    assert.equal(result.value.callee.value, "my_script");
  }
});

test("parseConstRhs: parses run capture with args as Expr.call", () => {
  const result = parseConstRhs(...src(['const x = my_script("arg")'], 0), 'my_script("arg")', 1, 1, "x");
  assert.equal(result.value.kind, "call");
  if (result.value.kind === "call") {
    assert.equal(result.value.callee.value, "my_script");
    assert.deepEqual(result.value.args, [{ kind: "literal", raw: '"arg"' }]);
  }
});

test("parseConstRhs: bare identifier without parens is a literal value, not a call", () => {
  const result = parseConstRhs(...src(["const x = my_script"], 0), "my_script", 1, 1, "x");
  assert.equal(result.value.kind, "literal");
});

test("parseConstRhs: parses call capture as Expr.call", () => {
  const result = parseConstRhs(...src(["const x = my_rule()"], 0), "my_rule()", 1, 1, "x");
  assert.equal(result.value.kind, "call");
  if (result.value.kind === "call") {
    assert.equal(result.value.callee.value, "my_rule");
  }
});

test("parseConstRhs: call with trailing content throws", () => {
  assert.throws(
    () => parseConstRhs(...src(["const x = my_rule() catch fail"], 0), "my_rule() catch fail", 1, 1, "x"),
    /unexpected content after const call/,
  );
});

test("parseConstRhs: prompt capture is allowed in def", () => {
  const result = parseConstRhs(...src(['const x = prompt "hello"'], 0), 'prompt "hello"', 1, 1, "x");
  assert.equal(result.value.kind, "prompt");
});

test("parseConstRhs: parses prompt capture as Expr.prompt", () => {
  const lines = ['  const x = prompt "What is your name?"'];
  const result = parseConstRhs(...src(lines, 0), 'prompt "What is your name?"', 1, 1, "x");
  assert.equal(result.value.kind, "prompt");
  if (result.value.kind === "prompt") {
    assert.equal(result.value.raw, '"What is your name?"');
  }
});
