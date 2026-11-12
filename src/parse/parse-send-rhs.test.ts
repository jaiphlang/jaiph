import test from "node:test";
import assert from "node:assert/strict";
import { BodyCursor } from "./body-cursor";
import { parseSendRhs } from "./send-rhs";

/** `parseSendRhs` for a payload written alone on line 1. */
function send(rhs: string, col: number) {
  return parseSendRhs(BodyCursor.of("test.jh", rhs), 0, rhs, col);
}

// === parseSendRhs: empty/whitespace RHS is rejected ===

test("parseSendRhs: empty RHS throws", () => {
  assert.throws(
    () => send("", 1),
    /use 'send <payload> -> <channel>'/,
  );
});

test("parseSendRhs: whitespace-only RHS throws", () => {
  assert.throws(
    () => send("   ", 1),
    /use 'send <payload> -> <channel>'/,
  );
});

// === parseSendRhs: literal ===

test("parseSendRhs: quoted string returns Expr.literal", () => {
  const { value } = send('"hello world"', 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, '"hello world"');
  }
});

test("parseSendRhs: quoted string with escaped quote", () => {
  const { value } = send('"say \\"hi\\""', 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, '"say \\"hi\\""');
  }
});

test("parseSendRhs: unterminated string throws", () => {
  assert.throws(
    () => send('"unterminated', 1),
    /multiline strings use triple quotes/,
  );
});

test("parseSendRhs: trailing content after quoted string throws", () => {
  assert.throws(
    () => send('"hello" extra', 1),
    /send right-hand side must be/,
  );
});

// === parseSendRhs: call ===

test("parseSendRhs: run call returns Expr.call", () => {
  const { value } = send("my_script()", 5);
  assert.equal(value.kind, "call");
  if (value.kind === "call") {
    assert.equal(value.callee.value, "my_script");
    assert.equal(value.callee.loc.line, 1);
    assert.equal(value.callee.loc.col, 5);
  }
});

test("parseSendRhs: run call with args", () => {
  const { value } = send('my_script("arg1")', 1);
  assert.equal(value.kind, "call");
  if (value.kind === "call") {
    assert.equal(value.callee.value, "my_script");
    assert.deepEqual(value.args, [{ kind: "literal", raw: '"arg1"' }]);
  }
});

test("parseSendRhs: run call with dotted ref", () => {
  const { value } = send("lib.process()", 1);
  assert.equal(value.kind, "call");
  if (value.kind === "call") {
    assert.equal(value.callee.value, "lib.process");
  }
});

// === parseSendRhs: bare variable (`$name`) is Expr.literal in the new model ===

test("parseSendRhs: simple variable returns Expr.literal", () => {
  const { value } = send("$myVar", 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, "$myVar");
  }
});

test("parseSendRhs: underscore variable", () => {
  const { value } = send("$_name", 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, "$_name");
  }
});

// === parseSendRhs: braced variable ===

test("parseSendRhs: braced variable returns Expr.literal", () => {
  const { value } = send("${myVar}", 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, "${myVar}");
  }
});

test("parseSendRhs: nested braced variable", () => {
  const { value } = send("${outer_${inner}}", 1);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.equal(value.raw, "${outer_${inner}}");
  }
});

test("parseSendRhs: unterminated braced variable throws", () => {
  assert.throws(
    () => send("${unterminated", 1),
    /unterminated \$\{/,
  );
});

test("parseSendRhs: braced variable with trailing content throws", () => {
  assert.throws(
    () => send("${myVar} extra", 1),
    /send right-hand side must be/,
  );
});

test("parseSendRhs: braced variable with command substitution throws", () => {
  assert.throws(
    () => send("${$(cmd)}", 1),
    /send right-hand side must be/,
  );
});

// === parseSendRhs: bare_ref ===

test("parseSendRhs: bare dotted ref returns Expr.bare_ref", () => {
  const { value } = send("lib.handler", 3);
  assert.equal(value.kind, "bare_ref");
  if (value.kind === "bare_ref") {
    assert.equal(value.ref.value, "lib.handler");
    assert.equal(value.ref.loc.line, 1);
    assert.equal(value.ref.loc.col, 3);
  }
});

// === parseSendRhs: shell ===

test("parseSendRhs: unrecognized expression returns Expr.shell", () => {
  const { value } = send("echo hello | grep h", 1);
  assert.equal(value.kind, "shell");
  if (value.kind === "shell") {
    assert.equal(value.command, "echo hello | grep h");
    assert.equal(value.loc.line, 1);
    assert.equal(value.loc.col, 1);
  }
});

// === parseSendRhs: triple-quoted literal ===

test("parseSendRhs: triple-quoted string returns Expr.literal", () => {
  const lines = ['"""', "  hello", "  world", '"""'];
  const cursor = BodyCursor.of("test.jh", lines.join("\n"));
  const { value, next } = parseSendRhs(cursor, 0, '"""', 6);
  assert.equal(value.kind, "literal");
  if (value.kind === "literal") {
    assert.ok(value.raw.includes("hello"));
    assert.ok(value.raw.includes("world"));
  }
  assert.equal(next, lines.join("\n").length + 1);
});
