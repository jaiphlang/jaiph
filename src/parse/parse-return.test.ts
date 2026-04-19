import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("return run parses managed run call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "run");
    if (step.managed!.kind === "run") {
      assert.equal(step.managed!.ref.value, "helper");
      assert.equal(step.managed!.args, undefined);
    }
    assert.equal(step.value, "run helper()");
  }
});

test("return run parses managed run call with args", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper("a", "b")\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "run");
    if (step.managed!.kind === "run") {
      assert.equal(step.managed!.ref.value, "helper");
      assert.equal(step.managed!.args, '"a" "b"');
    }
  }
});

test("return run parses dotted ref", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run lib.helper()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "run");
    if (step.managed!.kind === "run") {
      assert.equal(step.managed!.ref.value, "lib.helper");
    }
  }
});

test("return with string value has no managed field", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return "hello"\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.managed, undefined);
    assert.equal(step.value, '"hello"');
  }
});

test("bare return has no managed field", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.managed, undefined);
    assert.equal(step.value, '""');
  }
});
