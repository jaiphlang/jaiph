import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === Rejected: incomplete rule declarations ===

test("rule without parentheses or braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("rule foo", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require parentheses and braces") &&
      err.message.includes("rule foo() { … }"),
  );
});

test("rule with brace but no parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("rule foo {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require parentheses") &&
      err.message.includes("rule foo() { … }"),
  );
});

test("rule with colon instead of braces is rejected", () => {
  assert.throws(
    () => parsejaiph("rule foo:", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require parentheses and braces"),
  );
});

test("export rule without parentheses or braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export rule bar", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require parentheses and braces") &&
      err.message.includes("rule bar() { … }"),
  );
});

test("rule with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("rule gate()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("rule declarations require braces") &&
      err.message.includes("rule gate() { … }"),
  );
});

// === Rejected: incomplete script definitions ===

test("script without parentheses or braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("script greet", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script declarations require parentheses and braces") &&
      err.message.includes("script greet() { … }"),
  );
});

test("script with brace but no parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("script greet {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script declarations require parentheses") &&
      err.message.includes("script greet() { … }"),
  );
});

test("script with parens but no braces is rejected", () => {
  assert.throws(
    () => parsejaiph("script greet()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script declarations require braces"),
  );
});

// === Rejected: incomplete workflow definitions ===

test("workflow without parentheses or braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("workflow default", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require parentheses and braces") &&
      err.message.includes("workflow default() { … }"),
  );
});

test("workflow with brace but no parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require parentheses") &&
      err.message.includes("workflow default() { … }"),
  );
});

test("export workflow without parentheses or braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export workflow main", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require parentheses and braces") &&
      err.message.includes("workflow main() { … }"),
  );
});

test("workflow with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow main()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require braces") &&
      err.message.includes("workflow main() { … }"),
  );
});

// === Accepted: minimal/empty braced bodies ===

test("rule with empty braced body is accepted", () => {
  const mod = parsejaiph("rule check() {\n}", "test.jh");
  assert.equal(mod.rules.length, 1);
  assert.equal(mod.rules[0].name, "check");
  assert.equal(mod.rules[0].steps.length, 0);
});

test("script with empty braced body is accepted", () => {
  const mod = parsejaiph("script noop() {\n}", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "noop");
});

test("workflow with empty braced body is accepted", () => {
  const mod = parsejaiph("workflow default() {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "default");
  assert.equal(mod.workflows[0].steps.length, 0);
});

test("export workflow with empty braced body is accepted", () => {
  const mod = parsejaiph("export workflow main() {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "main");
  assert.deepEqual(mod.exports, ["main"]);
});

test("export rule with empty braced body is accepted", () => {
  const mod = parsejaiph("export rule check() {\n}", "test.jh");
  assert.equal(mod.rules.length, 1);
  assert.equal(mod.rules[0].name, "check");
  assert.deepEqual(mod.exports, ["check"]);
});
