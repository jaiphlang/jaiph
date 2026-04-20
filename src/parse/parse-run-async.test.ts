import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parse: run async produces run step with async flag", () => {
  const src = [
    "workflow default() {",
    "  run async some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "some_wf");
    assert.equal(step.async, true);
  }
});

test("parse: run async with args", () => {
  const src = [
    "workflow default() {",
    '  run async other_wf("hello" "$x")',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "other_wf");
    assert.equal(step.args, '"hello" "$x"');
    assert.equal(step.async, true);
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
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "mod.some_wf");
    assert.equal(step.async, true);
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
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.async, undefined);
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

test("parse: const capture + run async produces run_capture with async flag", () => {
  const src = [
    "workflow default() {",
    "  const h = run async some_wf()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.name, "h");
    assert.equal(step.value.kind, "run_capture");
    if (step.value.kind === "run_capture") {
      assert.equal(step.value.ref.value, "some_wf");
      assert.equal(step.value.async, true);
    }
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
  if (step.type === "const") {
    assert.equal(step.value.kind, "run_capture");
    if (step.value.kind === "run_capture") {
      assert.equal(step.value.ref.value, "other_wf");
      assert.equal(step.value.args, '"hello"');
      assert.equal(step.value.async, true);
    }
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
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "foo");
    assert.equal(step.async, true);
    assert.ok(step.recoverLoop);
    if (step.recoverLoop && "block" in step.recoverLoop) {
      assert.equal(step.recoverLoop.bindings.failure, "err");
      assert.equal(step.recoverLoop.block.length, 1);
      assert.equal(step.recoverLoop.block[0].type, "log");
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
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.async, true);
    assert.ok(step.recoverLoop);
    if (step.recoverLoop && "block" in step.recoverLoop) {
      assert.equal(step.recoverLoop.block.length, 2);
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
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "bar");
    assert.equal(step.async, true);
    assert.ok(step.recover);
    if (step.recover && "block" in step.recover) {
      assert.equal(step.recover.bindings.failure, "e");
    }
  }
});
