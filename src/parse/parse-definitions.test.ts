import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

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
      err.message.includes("workflow declarations require parentheses") &&
      err.message.includes("workflow default() { … }"),
  );
});

test("workflow with empty parentheses is accepted", () => {
  const mod = parsejaiph("workflow default() {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "default");
  assert.deepEqual(mod.workflows[0].params, []);
});

test("export workflow without braces is rejected with fix hint", () => {
  assert.throws(
    () => parsejaiph("export workflow main", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require parentheses") &&
      err.message.includes("workflow main() { … }"),
  );
});

test("workflow with parentheses but no brace is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow main()", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require braces") &&
      err.message.includes("workflow main()"),
  );
});

test("workflow without parentheses before opening brace is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default {\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("workflow declarations require parentheses"),
  );
});

// === Accepted: minimal/empty braced bodies ===

test("script with empty string body is accepted", () => {
  const mod = parsejaiph('script noop = ``', "test.jh");
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

// === Named parameters ===

test("workflow with named parameters is accepted", () => {
  const mod = parsejaiph("workflow greet(name, greeting) {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "greet");
  assert.deepEqual(mod.workflows[0].params, ["name", "greeting"]);
});

test("export workflow with named parameters is accepted", () => {
  const mod = parsejaiph("export workflow main(task, role) {\n}", "test.jh");
  assert.equal(mod.workflows.length, 1);
  assert.equal(mod.workflows[0].name, "main");
  assert.deepEqual(mod.workflows[0].params, ["task", "role"]);
  assert.deepEqual(mod.exports, ["main"]);
});

test("duplicate parameter name is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow greet(name, name) {\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes('duplicate parameter name "name"'),
  );
});

test("reserved keyword as parameter name is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow greet(run) {\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes('parameter name "run" is a reserved keyword'),
  );
});

test("log accepts a bare identifier (stored as interpolation)", () => {
  const mod = parsejaiph(
    ["workflow w() {", "  log msg", "}", ""].join("\n"),
    "test.jh",
  );
  assert.equal(mod.workflows[0].steps[0].type, "log");
  assert.equal((mod.workflows[0].steps[0] as { message: string }).message, "${msg}");
});

// === import script ===

test("import script parses into scriptImports", () => {
  const mod = parsejaiph(
    'import script "./queue.py" as queue\n\nworkflow default() {\n  run queue("get")\n}\n',
    "/tmp/test.jh",
  );
  assert.equal(mod.scriptImports?.length, 1);
  assert.equal(mod.scriptImports![0].path, "./queue.py");
  assert.equal(mod.scriptImports![0].alias, "queue");
});

test("import script name collides with inline script", () => {
  assert.throws(
    () =>
      parsejaiph(
        'import script "./q.py" as q\n\nscript q = `echo hi`\n',
        "/tmp/test.jh",
      ),
    /duplicate name "q"/,
  );
});

test("import script does not conflict with module imports", () => {
  const mod = parsejaiph(
    'import script "./helper.sh" as helper\nimport "other" as other\n\nworkflow w() {\n  run helper("x")\n}\n',
    "/tmp/test.jh",
  );
  assert.equal(mod.scriptImports?.length, 1);
  assert.equal(mod.imports.length, 1);
});
