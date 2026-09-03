import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === run bare identifier (no parens) is now rejected ===

test("run bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  run setup\n}`, "test.jh"),
    /parentheses are required/,
  );
});

test("run bare dotted identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  run lib.setup\n}`, "test.jh"),
    /parentheses are required/,
  );
});

test("run with args and parens still works", () => {
  const mod = parsejaiph(
    `export def main() {\n  run deploy("prod", "v1")\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "deploy");
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"prod"' },
      { kind: "literal", raw: '"v1"' },
    ]);
  }
});

// === run bare identifier (no parens) is now rejected ===

test("run bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(
      `def check() {\n  return "ok"\n}\nexport def main() {\n  run check\n}`,
      "test.jh",
    ),
    /parentheses are required/,
  );
});

// === if condition with bare identifier ===

test("if keyword with old syntax produces E_PARSE error", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "export def main() {",
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
    () => parsejaiph(`export def main() {\n  const x = run helper\n}`, "test.jh"),
    /must target a valid reference/,
  );
});

test("const x = run bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(
      `def check() {\n  return "ok"\n}\nexport def main() {\n  const x = run check\n}`,
      "test.jh",
    ),
    /must target a valid reference/,
  );
});

// === return run/run bare identifier (no parens) now falls through ===

test("return run bare identifier is E_PARSE, not shell", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  return run helper\n}`, "test.jh"),
    /return run requires a call/,
  );
});

test("return run bare identifier on a known def is E_PARSE, not shell", () => {
  assert.throws(
    () =>
      parsejaiph(
        `def check() {\n  return "ok"\n}\nexport def main() {\n  return run check\n}`,
        "test.jh",
      ),
    /return run requires a call/,
  );
});

// === send RHS with bare identifier (no parens) ===

test("send run bare identifier does not parse as send with call value -> channel", () => {
  // Without parens, the send RHS falls through to Expr.shell
  const mod = parsejaiph(
    [
      "channel alerts",
      "export def main() {",
      "  send run get_msg -> alerts",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "send");
  if (step.type === "send") {
    assert.equal(step.channel, "alerts");
    assert.equal(step.value.kind, "shell");
  }
});

// === run async bare identifier (no parens) is now rejected ===

test("run async bare identifier is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  run async bg_task\n}`, "test.jh"),
    /parentheses are required/,
  );
});

// === assignment capture without const is now rejected ===

test("x = run bare identifier is rejected — const required", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  x = run helper\n}`, "test.jh"),
    /assignment without "const" is no longer supported/,
  );
});

test("x = run bare identifier is rejected — const required", () => {
  assert.throws(
    () => parsejaiph(
      [
        "def check() {",
        '  return "ok"',
        "}",
        "export def main() {",
        "  x = run check",
        "}",
      ].join("\n"),
      "test.jh",
    ),
    /assignment without "const" is no longer supported/,
  );
});

// === definition without () remains a parse error ===

test("workflow definition without () is a parse error", () => {
  assert.throws(
    () => parsejaiph(`def setup{\n  log "hi"\n}`, "test.jh"),
    (err: any) => err.message.includes("require parentheses"),
  );
});

test("rule definition without () is a parse error", () => {
  assert.throws(
    () => parsejaiph(`def check{\n  return "ok"\n}`, "test.jh"),
    (err: any) => err.message.includes("require parentheses"),
  );
});

// === run with recover + bare identifier (no parens) is now rejected ===

test("run bare identifier with recover is rejected — parentheses required", () => {
  assert.throws(
    () => parsejaiph(
      [
        "def check() {",
        '  return "ok"',
        "}",
        "export def main() {",
        '  run check catch (failure) { log "retrying" }',
        "}",
      ].join("\n"),
      "test.jh",
    ),
    /parentheses are required/,
  );
});
