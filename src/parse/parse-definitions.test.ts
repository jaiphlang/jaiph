import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("'rule' is not a keyword; use 'def'", () => {
  assert.throws(
    () => parsejaiph("rule foo() {\n}", "test.jh"),
    (err: Error) => err.message.includes("E_PARSE") && err.message.includes("'rule' is not a keyword; use 'def'"),
  );
});

test("'workflow' is not a keyword; use 'def'", () => {
  assert.throws(
    () => parsejaiph("workflow foo() {\n}", "test.jh"),
    (err: Error) => err.message.includes("E_PARSE") && err.message.includes("'workflow' is not a keyword; use 'def'"),
  );
});

test("def without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("def foo", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("def declarations require parentheses") &&
      err.message.includes("def foo() { … }"),
  );
});

test("def with empty parentheses is accepted", () => {
  const mod = parsejaiph("def foo() {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "foo");
  assert.deepEqual(mod.defs[0].params, []);
});

test("def with colon instead of braces is rejected", () => {
  assert.throws(
    () => parsejaiph("def foo:", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") && err.message.includes("def declarations require parentheses"),
  );
});

test("export def without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export def bar", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("def declarations require parentheses") &&
      err.message.includes("def bar() { … }"),
  );
});

test("def with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("def gate()", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("def declarations require braces") &&
      err.message.includes("def gate()"),
  );
});

test("script without = is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("script greet", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") && err.message.includes("script definitions require = after the name"),
  );
});

test("script with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("script greet()", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") && err.message.includes("definitions must not use parentheses"),
  );
});

test("def without parentheses before opening brace is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main {\n}", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") && err.message.includes("def declarations require parentheses"),
  );
});

test("def with empty braced body is accepted", () => {
  const mod = parsejaiph("def check() {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "check");
  assert.equal(mod.defs[0].steps.length, 0);
});

test("script with empty string body is accepted", () => {
  const mod = parsejaiph("script noop = ``", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "noop");
});

test("export def main with empty braced body is accepted", () => {
  const mod = parsejaiph("export def main() {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "main");
  assert.deepEqual(mod.exports, ["main"]);
});

test("export def with empty braced body is accepted", () => {
  const mod = parsejaiph("export def check() {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "check");
  assert.deepEqual(mod.exports, ["check"]);
});

test("def with named parameters is accepted", () => {
  const mod = parsejaiph("def greet(name, greeting) {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "greet");
  assert.deepEqual(mod.defs[0].params, ["name", "greeting"]);
});

test("export def with named parameters is accepted", () => {
  const mod = parsejaiph("export def main(task, role) {\n}", "test.jh");
  assert.equal(mod.defs.length, 1);
  assert.equal(mod.defs[0].name, "main");
  assert.deepEqual(mod.defs[0].params, ["task", "role"]);
  assert.deepEqual(mod.exports, ["main"]);
});

test("duplicate parameter name is rejected", () => {
  assert.throws(
    () => parsejaiph("def greet(name, name) {\n}", "test.jh"),
    (err: Error) => err.message.includes("E_PARSE") && err.message.includes('duplicate parameter name "name"'),
  );
});

test("reserved keyword as parameter name is rejected", () => {
  assert.throws(
    () => parsejaiph("def greet(run) {\n}", "test.jh"),
    (err: Error) =>
      err.message.includes("E_PARSE") && err.message.includes('parameter name "run" is a reserved keyword'),
  );
});

test("log accepts a bare identifier (stored as interpolation Expr.literal)", () => {
  const mod = parsejaiph(["def w() {", "  log msg", "}", ""].join("\n"), "test.jh");
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "say");
  if (step.type === "say") {
    assert.equal(step.level, "log");
    assert.equal(step.message.kind, "literal");
    if (step.message.kind === "literal") {
      assert.equal(step.message.raw, "${msg}");
    }
  }
});

test("import script parses into scriptImports", () => {
  const mod = parsejaiph(
    'import script "./queue.py" as queue\n\nexport def main() {\n  run queue("get")\n}\n',
    "/tmp/test.jh",
  );
  assert.equal(mod.scriptImports?.length, 1);
  assert.equal(mod.scriptImports![0].path, "./queue.py");
  assert.equal(mod.scriptImports![0].alias, "queue");
});

test("import script name collides with inline script", () => {
  assert.throws(
    () => parsejaiph('import script "./q.py" as q\n\nscript q = `echo hi`\n', "/tmp/test.jh"),
    /duplicate name "q"/,
  );
});

test("import script does not conflict with module imports", () => {
  const mod = parsejaiph(
    'import script "./helper.sh" as helper\nimport "other" as other\n\ndef w() {\n  run helper("x")\n}\n',
    "/tmp/test.jh",
  );
  assert.equal(mod.scriptImports?.length, 1);
  assert.equal(mod.imports.length, 1);
});
