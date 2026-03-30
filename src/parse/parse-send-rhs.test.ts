import test from "node:test";
import assert from "node:assert/strict";
import { parseSendRhs } from "./send-rhs";

// === parseSendRhs: forward ===

test("parseSendRhs: empty RHS returns forward kind", () => {
  const result = parseSendRhs("test.jh", "", 1, 1);
  assert.equal(result.kind, "forward");
});

test("parseSendRhs: whitespace-only RHS returns forward kind", () => {
  const result = parseSendRhs("test.jh", "   ", 1, 1);
  assert.equal(result.kind, "forward");
});

// === parseSendRhs: literal ===

test("parseSendRhs: quoted string returns literal kind", () => {
  const result = parseSendRhs("test.jh", '"hello world"', 1, 1);
  assert.equal(result.kind, "literal");
  if (result.kind === "literal") {
    assert.equal(result.token, '"hello world"');
  }
});

test("parseSendRhs: quoted string with escaped quote", () => {
  const result = parseSendRhs("test.jh", '"say \\"hi\\""', 1, 1);
  assert.equal(result.kind, "literal");
  if (result.kind === "literal") {
    assert.equal(result.token, '"say \\"hi\\""');
  }
});

test("parseSendRhs: unterminated string throws", () => {
  assert.throws(
    () => parseSendRhs("test.jh", '"unterminated', 1, 1),
    /unterminated string/,
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
  const result = parseSendRhs("test.jh", "run my_script()", 1, 5);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.ref.value, "my_script");
    assert.equal(result.ref.loc.line, 1);
    assert.equal(result.ref.loc.col, 5);
  }
});

test("parseSendRhs: run call with args", () => {
  const result = parseSendRhs("test.jh", 'run my_script("arg1")', 1, 1);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.ref.value, "my_script");
    assert.equal(result.args, '"arg1"');
  }
});

test("parseSendRhs: run call with dotted ref", () => {
  const result = parseSendRhs("test.jh", "run lib.process()", 1, 1);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.ref.value, "lib.process");
  }
});

// === parseSendRhs: var ===

test("parseSendRhs: simple variable returns var kind", () => {
  const result = parseSendRhs("test.jh", "$myVar", 1, 1);
  assert.equal(result.kind, "var");
  if (result.kind === "var") {
    assert.equal(result.bash, "$myVar");
  }
});

test("parseSendRhs: underscore variable", () => {
  const result = parseSendRhs("test.jh", "$_name", 1, 1);
  assert.equal(result.kind, "var");
  if (result.kind === "var") {
    assert.equal(result.bash, "$_name");
  }
});

// === parseSendRhs: braced variable ===

test("parseSendRhs: braced variable returns var kind", () => {
  const result = parseSendRhs("test.jh", "${myVar}", 1, 1);
  assert.equal(result.kind, "var");
  if (result.kind === "var") {
    assert.equal(result.bash, "${myVar}");
  }
});

test("parseSendRhs: nested braced variable", () => {
  const result = parseSendRhs("test.jh", "${outer_${inner}}", 1, 1);
  assert.equal(result.kind, "var");
  if (result.kind === "var") {
    assert.equal(result.bash, "${outer_${inner}}");
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
  const result = parseSendRhs("test.jh", "lib.handler", 1, 3);
  assert.equal(result.kind, "bare_ref");
  if (result.kind === "bare_ref") {
    assert.equal(result.ref.value, "lib.handler");
    assert.equal(result.ref.loc.line, 1);
    assert.equal(result.ref.loc.col, 3);
  }
});

// === parseSendRhs: shell ===

test("parseSendRhs: unrecognized expression returns shell kind", () => {
  const result = parseSendRhs("test.jh", "echo hello | grep h", 1, 1);
  assert.equal(result.kind, "shell");
  if (result.kind === "shell") {
    assert.equal(result.command, "echo hello | grep h");
    assert.equal(result.loc.line, 1);
    assert.equal(result.loc.col, 1);
  }
});
