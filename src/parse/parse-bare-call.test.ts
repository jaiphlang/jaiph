import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === run bare identifier (no parens) is now rejected ===

test("run bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`workflow default() {\n  run setup\n}`, "test.jh"),
    /parentheses are required/,
  );
});

test("run bare dotted identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`workflow default() {\n  run lib.setup\n}`, "test.jh"),
    /parentheses are required/,
  );
});

test("run with args and parens still works", () => {
  const mod = parsejaiph(
    `workflow default() {\n  run deploy("prod", "v1")\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "deploy");
    assert.equal(step.args, '"prod" "v1"');
  }
});

// === if condition with bare identifier ===

test("if keyword with old syntax produces E_PARSE error", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "workflow default() {",
          "  if not run exists {",
          '    log "missing"',
          "  }",
          "}",
        ].join("\n"),
        "test.jh",
      ),
    /invalid if syntax/,
  );
});

// === const capture with bare identifier (no parens) is now rejected ===

test("const x = run bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`workflow default() {\n  const x = run helper\n}`, "test.jh"),
    /must target a valid reference/,
  );
});

// === return run/ensure bare identifier (no parens) now falls through ===

test("return run bare identifier does not parse as managed return", () => {
  // Without parens, "return run helper" is not recognized as a managed return
  // and falls through to a shell step
  const mod = parsejaiph(
    `workflow default() {\n  return run helper\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "shell");
});

// === send RHS with bare identifier (no parens) ===

test("channel <- run bare identifier does not parse as send with run RHS", () => {
  // Without parens, the send RHS falls through to shell kind
  const mod = parsejaiph(
    [
      "channel alerts",
      "workflow default() {",
      "  alerts <- run get_msg",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  if (step.type === "send") {
    assert.equal(step.channel, "alerts");
    // Without parens, parseCallRef returns null, so it falls through to shell kind
    assert.equal(step.rhs.kind, "shell");
  }
});

// === run async bare identifier (no parens) is now rejected ===

test("run async bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`workflow default() {\n  run async bg_task\n}`, "test.jh"),
    /parentheses are required/,
  );
});

// === assignment capture without const is now rejected ===

test("x = run bare identifier is rejected — const required", () => {
  assert.throws(
    () => parsejaiph(`workflow default() {\n  x = run helper\n}`, "test.jh"),
    /assignment without "const" is no longer supported/,
  );
});

// === definition without () remains a parse error ===

test("workflow definition without () is a parse error", () => {
  assert.throws(
    () => parsejaiph(`workflow setup {\n  log "hi"\n}`, "test.jh"),
    (err: any) => err.message.includes("require parentheses"),
  );
});

