import test from "node:test";
import assert from "node:assert/strict";
import { parseSendRhs } from "./send-rhs";

// === parseSendRhs: empty/whitespace RHS is now rejected ===

test("parseSendRhs: empty RHS returns forward kind", () => {
  assert.throws(
    () => parseSendRhs("test.jh", "", 1, 1),
    /send requires an explicit payload/,
  );
});

test("parseSendRhs: whitespace-only RHS returns forward kind", () => {
  assert.throws(
    () => parseSendRhs("test.jh", "   ", 1, 1),
    /send requires an explicit payload/,
  );
});

// === parseSendRhs: literal ===

test("parseSendRhs: quoted string returns literal kind", () => {
  const { rhs } = parseSendRhs("test.jh", '"hello world"', 1, 1);
  assert.equal(rhs.kind, "literal");
  if (rhs.kind === "literal") {
    assert.equal(rhs.token, '"hello world"');
  }
});

test("parseSendRhs: quoted string with escaped quote", () => {
  const { rhs } = parseSendRhs("test.jh", '"say \\"hi\\""', 1, 1);
  assert.equal(rhs.kind, "literal");
  if (rhs.kind === "literal") {
    assert.equal(rhs.token, '"say \\"hi\\""');
  }
});

test("parseSendRhs: unterminated string throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", '"unterminated', 1, 1),
    /multiline strings use triple quotes/,
  );
});

test("parseSendRhs: trailing content after quoted string throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", '"hello" extra', 1, 1),
    /send right-hand side must be/,
  );
});

// === parseSendRhs: run ===

test("parseSendRhs: run call returns run kind", () => {
  const { rhs } = parseSendRhs("test.jh", "run my_script()", 1, 5);
  assert.equal(rhs.kind, "run");
  if (rhs.kind === "run") {
    assert.equal(rhs.ref.value, "my_script");
    assert.equal(rhs.ref.loc.line, 1);
    assert.equal(rhs.ref.loc.col, 5);
  }
});

test("parseSendRhs: run call with args", () => {
  const { rhs } = parseSendRhs("test.jh", 'run my_script("arg1")', 1, 1);
  assert.equal(rhs.kind, "run");
  if (rhs.kind === "run") {
    assert.equal(rhs.ref.value, "my_script");
    assert.equal(rhs.args, '"arg1"');
  }
});

test("parseSendRhs: run call with dotted ref", () => {
  const { rhs } = parseSendRhs("test.jh", "run lib.process()", 1, 1);
  assert.equal(rhs.kind, "run");
  if (rhs.kind === "run") {
    assert.equal(rhs.ref.value, "lib.process");
  }
});

// === parseSendRhs: var ===

test("parseSendRhs: simple variable returns var kind", () => {
  const { rhs } = parseSendRhs("test.jh", "$myVar", 1, 1);
  assert.equal(rhs.kind, "var");
  if (rhs.kind === "var") {
    assert.equal(rhs.bash, "$myVar");
  }
});

test("parseSendRhs: underscore variable", () => {
  const { rhs } = parseSendRhs("test.jh", "$_name", 1, 1);
  assert.equal(rhs.kind, "var");
  if (rhs.kind === "var") {
    assert.equal(rhs.bash, "$_name");
  }
});

// === parseSendRhs: braced variable ===

test("parseSendRhs: braced variable returns var kind", () => {
  const { rhs } = parseSendRhs("test.jh", "${myVar}", 1, 1);
  assert.equal(rhs.kind, "var");
  if (rhs.kind === "var") {
    assert.equal(rhs.bash, "${myVar}");
  }
});

test("parseSendRhs: nested braced variable", () => {
  const { rhs } = parseSendRhs("test.jh", "${outer_${inner}}", 1, 1);
  assert.equal(rhs.kind, "var");
  if (rhs.kind === "var") {
    assert.equal(rhs.bash, "${outer_${inner}}");
  }
});

test("parseSendRhs: unterminated braced variable throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", "${unterminated", 1, 1),
    /unterminated \$\{/,
  );
});

test("parseSendRhs: braced variable with trailing content throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", "${myVar} extra", 1, 1),
    /send right-hand side must be/,
  );
});

test("parseSendRhs: braced variable with command substitution throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", "${$(cmd)}", 1, 1),
    /send right-hand side must be/,
  );
});

// === parseSendRhs: bare_ref ===

test("parseSendRhs: bare dotted ref returns bare_ref kind", () => {
  const { rhs } = parseSendRhs("test.jh", "lib.handler", 1, 3);
  assert.equal(rhs.kind, "bare_ref");
  if (rhs.kind === "bare_ref") {
    assert.equal(rhs.ref.value, "lib.handler");
    assert.equal(rhs.ref.loc.line, 1);
    assert.equal(rhs.ref.loc.col, 3);
  }
});

// === parseSendRhs: shell ===

test("parseSendRhs: unrecognized expression returns shell kind", () => {
  const { rhs } = parseSendRhs("test.jh", "echo hello | grep h", 1, 1);
  assert.equal(rhs.kind, "shell");
  if (rhs.kind === "shell") {
    assert.equal(rhs.command, "echo hello | grep h");
    assert.equal(rhs.loc.line, 1);
    assert.equal(rhs.loc.col, 1);
  }
});

// === parseSendRhs: triple-quoted literal ===

test("parseSendRhs: triple-quoted string returns literal kind", () => {
  const lines = ['ch <- """', "  hello", "  world", '"""'];
  const { rhs, nextIdx } = parseSendRhs("test.jh", '"""', 1, 6, lines, 0);
  assert.equal(rhs.kind, "literal");
  if (rhs.kind === "literal") {
    assert.ok(rhs.token.includes("hello"));
    assert.ok(rhs.token.includes("world"));
  }
  assert.equal(nextIdx, 4);
});
