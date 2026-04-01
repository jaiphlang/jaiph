import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === Rejected: incomplete rule declarations ===

test("rule without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("rule foo", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require braces") &&
      err.message.includes("rule foo { … }"),
  );
});

test("rule with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("rule foo() {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses") &&
      err.message.includes("rule foo { … }"),
  );
});

test("rule with colon instead of braces is rejected", () => {
  assert.throws(
    () => parsejaiph("rule foo:", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require braces"),
  );
});

test("export rule without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export rule bar", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require braces") &&
      err.message.includes("rule bar { … }"),
  );
});

test("rule with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("rule gate()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses") &&
      err.message.includes("rule gate { … }"),
  );
});

// === Rejected: incomplete script definitions ===

test("script without = is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("script greet", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script definitions require = after the name"),
  );
});

test("script with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("script greet()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses"),
  );
});

test("script with parens but no body is rejected", () => {
  assert.throws(
    () => parsejaiph("script greet()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses"),
  );
});

// === Rejected: incomplete workflow definitions ===

test("workflow without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("workflow default", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require braces") &&
      err.message.includes("workflow default { … }"),
  );
});

test("workflow with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default() {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses") &&
      err.message.includes("workflow default { … }"),
  );
});

test("export workflow without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export workflow main", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require braces") &&
      err.message.includes("workflow main { … }"),
  );
});

test("workflow with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow main()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses") &&
      err.message.includes("workflow main { … }"),
  );
});

// === Accepted: minimal/empty braced bodies ===

test("rule with empty braced body is accepted", () => {
  const mod = parsejaiph("rule check {\n}", "test.jh");
  assert.equal(mod.rules.length, 1);
  assert.equal(mod.rules[0].name, "check");
  assert.equal(mod.rules[0].steps.length, 0);
});

test("script with empty string body is accepted", () => {
  const mod = parsejaiph('script noop = ""', "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "noop");
});

test("workflow with empty braced body is accepted", () => {
  const mod = parsejaiph("workflow default {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "default");
  assert.equal(mod.workflows[0].steps.length, 0);
});

test("export workflow with empty braced body is accepted", () => {
  const mod = parsejaiph("export workflow main {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "main");
  assert.deepEqual(mod.exports, ["main"]);
});

test("export rule with empty braced body is accepted", () => {
  const mod = parsejaiph("export rule check {\n}", "test.jh");
  assert.equal(mod.rules.length, 1);
  assert.equal(mod.rules[0].name, "check");
  assert.deepEqual(mod.exports, ["check"]);
});
