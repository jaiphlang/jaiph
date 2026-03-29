import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parse: run async produces run step with async flag", () => {
  const src = [
    "workflow default() {",
    "  run async some_wf",
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
    '  run async other_wf "hello" "$x"',
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
    "  run async mod.some_wf",
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
    "  run some_wf",
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
    "  x = run async some_wf",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /capture is not supported with run async/,
  );
});
