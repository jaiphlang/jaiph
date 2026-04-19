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

test("parse: capture + run async is rejected", () => {
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

test("parse: run async with recover block", () => {
  const src = [
    "workflow default() {",
    '  run async foo() recover(err) {',
    '    log "$err"',
    '  }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "foo");
    assert.equal(step.async, true);
    assert.ok(step.recoverLoop, "recoverLoop should be set");
    assert.equal(step.recoverLoop!.bindings.failure, "err");
  }
});

test("parse: run async isolated with recover block", () => {
  const src = [
    "workflow default() {",
    '  run async isolated bar() recover(e) {',
    '    log "$e"',
    '  }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "bar");
    assert.equal(step.async, true);
    assert.equal(step.isolated, true);
    assert.ok(step.recoverLoop, "recoverLoop should be set");
    assert.equal(step.recoverLoop!.bindings.failure, "e");
  }
});

test("parse: run async with catch block", () => {
  const src = [
    "workflow default() {",
    '  run async foo() catch (err) {',
    '    log "$err"',
    '  }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "foo");
    assert.equal(step.async, true);
    assert.ok(step.recover, "recover should be set");
    assert.equal(step.recover!.bindings.failure, "err");
  }
});

test("parse: run async isolated with catch block", () => {
  const src = [
    "workflow default() {",
    '  run async isolated foo() catch (err) {',
    '    log "$err"',
    '  }',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "foo");
    assert.equal(step.async, true);
    assert.equal(step.isolated, true);
    assert.ok(step.recover, "recover should be set");
    assert.equal(step.recover!.bindings.failure, "err");
  }
});

test("parse: const = run async ref produces async run_capture", () => {
  const src = [
    "workflow default() {",
    "  const h = run async slow_op()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "run_capture");
    if (step.value.kind === "run_capture") {
      assert.equal(step.value.ref.value, "slow_op");
      assert.equal(step.value.async, true);
      assert.equal(step.value.isolated, undefined);
    }
  }
});

test("parse: const = run async isolated ref produces async+isolated run_capture", () => {
  const src = [
    "workflow default() {",
    "  const h = run async isolated slow_op()",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const step = mod.workflows[0]!.steps[0]!;
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "run_capture");
    if (step.value.kind === "run_capture") {
      assert.equal(step.value.ref.value, "slow_op");
      assert.equal(step.value.async, true);
      assert.equal(step.value.isolated, true);
    }
  }
});
