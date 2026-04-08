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
    assert.equal(step.managed!.ref.value, "helper");
    assert.equal(step.managed!.args, undefined);
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
    assert.equal(step.managed!.ref.value, "helper");
    assert.equal(step.managed!.args, '"a" "b"');
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
    assert.equal(step.managed!.ref.value, "lib.helper");
  }
});

test("return ensure parses managed ensure call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return ensure check()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "ensure");
    assert.equal(step.managed!.ref.value, "check");
    assert.equal(step.managed!.args, undefined);
    assert.equal(step.value, "ensure check()");
  }
});

test("return ensure parses managed ensure call with args", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return ensure check("x")\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "ensure");
    assert.equal(step.managed!.args, '"x"');
  }
});

test("return run in rule parses managed run call", () => {
  const mod = parsejaiph(
    `script helper = \`echo "ok"\`\nrule my_rule() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.rules[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.ok(step.managed);
    assert.equal(step.managed!.kind, "run");
    assert.equal(step.managed!.ref.value, "helper");
  }
});

test("return ensure in rule parses managed ensure call", () => {
  const mod = parsejaiph(
    `rule sub_rule() {\n  return "ok"\n}\nrule my_rule() {\n  return ensure sub_rule()\n}`,
    "test.jh",
  );
  const step = mod.rules[0].steps[1];
  // The rule that contains `return ensure sub_rule()` is my_rule (index 1)
  const myRule = mod.rules.find(r => r.name === "my_rule")!;
  const retStep = myRule.steps[0];
  assert.equal(retStep.type, "return");
  if (retStep.type === "return") {
    assert.ok(retStep.managed);
    assert.equal(retStep.managed!.kind, "ensure");
    assert.equal(retStep.managed!.ref.value, "sub_rule");
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

test("return run in ensure recover block", () => {
  const mod = parsejaiph(
    [
      'script helper = `echo "ok"`',
      "rule check() {",
      '  return "yes"',
      "}",
      "workflow default() {",
      "  ensure check() recover (err) {",
      "    return run helper()",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const ensureStep = mod.workflows[0].steps[0];
  assert.equal(ensureStep.type, "ensure");
  if (ensureStep.type === "ensure") {
    assert.ok(ensureStep.recover);
    const recoverSteps = "block" in ensureStep.recover! ? ensureStep.recover!.block : [ensureStep.recover!.single];
    const retStep = recoverSteps[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return") {
      assert.ok(retStep.managed);
      assert.equal(retStep.managed!.kind, "run");
      assert.equal(retStep.managed!.ref.value, "helper");
    }
  }
});
