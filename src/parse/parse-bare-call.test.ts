import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// === run bare identifier ===

test("run bare identifier parses as zero-arg call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  run setup\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "setup");
    assert.equal(step.args, undefined);
  }
});

test("run bare identifier parses identically to run ref()", () => {
  const bare = parsejaiph(
    `workflow default() {\n  run setup\n}`,
    "test.jh",
  );
  const paren = parsejaiph(
    `workflow default() {\n  run setup()\n}`,
    "test.jh",
  );
  const bareStep = bare.workflows[0].steps[0];
  const parenStep = paren.workflows[0].steps[0];
  assert.equal(bareStep.type, "run");
  assert.equal(parenStep.type, "run");
  if (bareStep.type === "run" && parenStep.type === "run") {
    assert.equal(bareStep.workflow.value, parenStep.workflow.value);
    assert.equal(bareStep.args, parenStep.args);
  }
});

test("run bare dotted identifier parses as zero-arg call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  run lib.setup\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "lib.setup");
    assert.equal(step.args, undefined);
  }
});

test("run with args still requires parens", () => {
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

// === ensure bare identifier ===

test("ensure bare identifier parses as zero-arg call", () => {
  const mod = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  ensure check\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "ensure");
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "check");
    assert.equal(step.args, undefined);
  }
});

test("ensure bare identifier parses identically to ensure ref()", () => {
  const bare = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  ensure check\n}`,
    "test.jh",
  );
  const paren = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  ensure check()\n}`,
    "test.jh",
  );
  const bareStep = bare.workflows[0].steps[0];
  const parenStep = paren.workflows[0].steps[0];
  assert.equal(bareStep.type, "ensure");
  assert.equal(parenStep.type, "ensure");
  if (bareStep.type === "ensure" && parenStep.type === "ensure") {
    assert.equal(bareStep.ref.value, parenStep.ref.value);
    assert.equal(bareStep.args, parenStep.args);
  }
});

// === if condition with bare identifier ===

test("if not run bare identifier parses correctly", () => {
  const mod = parsejaiph(
    [
      "workflow default() {",
      "  if not run exists {",
      '    log "missing"',
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "if");
  if (step.type === "if") {
    assert.equal(step.negated, true);
    assert.equal(step.condition.kind, "run");
    assert.equal(step.condition.ref.value, "exists");
    assert.equal(step.condition.args, undefined);
  }
});

test("if ensure bare identifier parses correctly", () => {
  const mod = parsejaiph(
    [
      "rule ready() {",
      '  return "ok"',
      "}",
      "workflow default() {",
      "  if ensure ready {",
      '    log "ready"',
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "if");
  if (step.type === "if") {
    assert.equal(step.negated, false);
    assert.equal(step.condition.kind, "ensure");
    assert.equal(step.condition.ref.value, "ready");
    assert.equal(step.condition.args, undefined);
  }
});

// === const capture with bare identifier ===

test("const x = run bare identifier parses as run capture", () => {
  const mod = parsejaiph(
    `workflow default() {\n  const x = run helper\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "run_capture");
    if (step.value.kind === "run_capture") {
      assert.equal(step.value.ref.value, "helper");
      assert.equal(step.value.args, undefined);
    }
  }
});

test("const x = ensure bare identifier parses as ensure capture", () => {
  const mod = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  const x = ensure check\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "ensure_capture");
    if (step.value.kind === "ensure_capture") {
      assert.equal(step.value.ref.value, "check");
      assert.equal(step.value.args, undefined);
    }
  }
});

// === return run/ensure bare identifier ===

test("return run bare identifier parses as managed return", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "run");
    assert.equal(step.managed!.ref.value, "helper");
    assert.equal(step.managed!.args, undefined);
  }
});

test("return ensure bare identifier parses as managed return", () => {
  const mod = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  return ensure check\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "ensure");
    assert.equal(step.managed!.ref.value, "check");
    assert.equal(step.managed!.args, undefined);
  }
});

// === send RHS with bare identifier ===

test("channel <- run bare identifier parses as send with run RHS", () => {
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
    assert.equal(step.rhs.kind, "run");
    if (step.rhs.kind === "run") {
      assert.equal(step.rhs.ref.value, "get_msg");
      assert.equal(step.rhs.args, undefined);
    }
  }
});

// === run async bare identifier ===

test("run async bare identifier parses correctly", () => {
  const mod = parsejaiph(
    `workflow default() {\n  run async bg_task\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "bg_task");
    assert.equal(step.args, undefined);
    assert.equal(step.async, true);
  }
});

// === capture with bare identifier ===

test("x = run bare identifier parses as run with capture", () => {
  const mod = parsejaiph(
    `workflow default() {\n  x = run helper\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "helper");
    assert.equal(step.captureName, "x");
    assert.equal(step.args, undefined);
  }
});

test("x = ensure bare identifier parses as ensure with capture", () => {
  const mod = parsejaiph(
    [
      "rule check() {",
      '  return "ok"',
      "}",
      "workflow default() {",
      "  x = ensure check",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "ensure");
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "check");
    assert.equal(step.captureName, "x");
    assert.equal(step.args, undefined);
  }
});

// === definition without () remains a parse error ===

test("workflow definition without () is a parse error", () => {
  assert.throws(
    () => parsejaiph(`workflow setup {\n  log "hi"\n}`, "test.jh"),
    (err: any) => err.message.includes("require parentheses"),
  );
});

test("rule definition without () is a parse error", () => {
  assert.throws(
    () => parsejaiph(`rule check {\n  return "ok"\n}`, "test.jh"),
    (err: any) => err.message.includes("require parentheses"),
  );
});

// === ensure with recover + bare identifier ===

test("ensure bare identifier with recover block parses correctly", () => {
  const mod = parsejaiph(
    [
      "rule check() {",
      '  return "ok"',
      "}",
      "workflow default() {",
      '  ensure check recover { log "retrying" }',
      "}",
    ].join("\n"),
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "ensure");
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "check");
    assert.equal(step.args, undefined);
    assert.ok(step.recover);
  }
});
