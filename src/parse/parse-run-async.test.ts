import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parse: run async produces exec/call with async flag on the body", () => {
  const src = [
    "workflow default() {",
    "  run async some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "some_wf");
    assert.equal(step.body.async, true);
  }
});

test("parse: run async with args", () => {
  const src = [
    "workflow default() {",
    '  run async other_wf("hello", "$x")',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "other_wf");
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"hello"' },
      { kind: "literal", raw: '"$x"' },
    ]);
    assert.equal(step.body.async, true);
  }
});

test("parse: run async with qualified ref", () => {
  const src = [
    "workflow default() {",
    "  run async mod.some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "mod.some_wf");
    assert.equal(step.body.async, true);
  }
});

test("parse: regular run does not have async flag", () => {
  const src = [
    "workflow default() {",
    "  run some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.async, undefined);
  }
});

test("parse: capture + run async is rejected without const", () => {
  const src = [
    "workflow default() {",
    "  x = run async some_wf()",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /assignment without "const" is no longer supported/,
  );
});

test("parse: const capture + run async produces Expr.call with async flag", () => {
  const src = [
    "workflow default() {",
    "  const h = run async some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "const");
  if (step.type === "const" && step.value.kind === "call") {
    assert.equal(step.name, "h");
    assert.equal(step.value.callee.value, "some_wf");
    assert.equal(step.value.async, true);
  }
});

test("parse: const capture + run async with args", () => {
  const src = [
    "workflow default() {",
    '  const h = run async other_wf("hello")',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "const");
  if (step.type === "const" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "other_wf");
    assert.deepEqual(step.value.args, [{ kind: "literal", raw: '"hello"' }]);
    assert.equal(step.value.async, true);
  }
});

test("parse: run async with recover block", () => {
  const src = [
    "workflow default() {",
    '  run async foo() recover(err) { log "repair" }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "foo");
    assert.equal(step.body.async, true);
    assert.ok(step.recover);
    if (step.recover && "block" in step.recover) {
      assert.equal(step.recover.bindings.failure, "err");
      assert.equal(step.recover.block.length, 1);
      assert.equal(step.recover.block[0].type, "say");
    }
  }
});

test("parse: run async with multi-line recover block", () => {
  const src = [
    "workflow default() {",
    "  run async foo() recover(err) {",
    '    log "repairing"',
    "    run fix_it()",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.async, true);
    assert.ok(step.recover);
    if (step.recover && "block" in step.recover) {
      assert.equal(step.recover.block.length, 2);
    }
  }
});

test("parse: run async with catch block", () => {
  const src = [
    "workflow default() {",
    '  run async bar() catch (e) { log "caught" }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "bar");
    assert.equal(step.body.async, true);
    assert.ok(step.catch);
    if (step.catch && "block" in step.catch) {
      assert.equal(step.catch.bindings.failure, "e");
    }
  }
});
