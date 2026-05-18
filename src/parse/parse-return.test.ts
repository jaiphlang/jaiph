import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("return run parses Expr.call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "call");
    if (step.value.kind === "call") {
      assert.equal(step.value.callee.value, "helper");
      assert.equal(step.value.args, undefined);
    }
  }
});

test("return run parses Expr.call with args", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper("a", "b")\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "helper");
    assert.deepEqual(step.value.args, [
      { kind: "literal", raw: '"a"' },
      { kind: "literal", raw: '"b"' },
    ]);
  }
});

test("return run parses dotted ref", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run lib.helper()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "lib.helper");
  }
});

test("return ensure parses Expr.ensure_call", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return ensure check()\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "ensure_call");
    if (step.value.kind === "ensure_call") {
      assert.equal(step.value.callee.value, "check");
      assert.equal(step.value.args, undefined);
    }
  }
});

test("return ensure parses Expr.ensure_call with args", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return ensure check("x")\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "ensure_call") {
    assert.deepEqual(step.value.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("return run in rule parses Expr.call", () => {
  const mod = parsejaiph(
    `script helper = \`echo "ok"\`\nrule my_rule() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.rules[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "helper");
  }
});

test("return ensure in rule parses Expr.ensure_call", () => {
  const mod = parsejaiph(
    `rule sub_rule() {\n  return "ok"\n}\nrule my_rule() {\n  return ensure sub_rule()\n}`,
    "test.jh",
  );
  const myRule = mod.rules.find(r => r.name === "my_rule")!;
  const retStep = myRule.steps[0];
  assert.equal(retStep.type, "return");
  if (retStep.type === "return" && retStep.value.kind === "ensure_call") {
    assert.equal(retStep.value.callee.value, "sub_rule");
  }
});

test("return with string value is Expr.literal", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return "hello"\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "literal");
    if (step.value.kind === "literal") {
      assert.equal(step.value.raw, '"hello"');
    }
  }
});

test("bare return is Expr.literal with empty string", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "literal");
    if (step.value.kind === "literal") {
      assert.equal(step.value.raw, '""');
    }
  }
});

test("return run inline script parses Expr.inline_script", () => {
  const mod = parsejaiph(
    "workflow default() {\n  return run `cat report.txt`()\n}",
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "inline_script") {
    assert.equal(step.value.body, "cat report.txt");
    assert.equal(step.value.args, undefined);
  } else {
    assert.fail(`expected return/inline_script, got ${step.type}`);
  }
});

test("return run inline script with args", () => {
  const mod = parsejaiph(
    'workflow default() {\n  return run `echo $1`("x")\n}',
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "inline_script") {
    assert.equal(step.value.body, "echo $1");
    assert.deepEqual(step.value.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("return bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default() {\n  return `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in return are not allowed/,
  );
});

test("log run inline script parses say with inline_script message", () => {
  const mod = parsejaiph(
    "workflow default() {\n  log run `cat report.txt`()\n}",
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "say");
  if (step.type === "say") {
    assert.equal(step.level, "log");
    assert.equal(step.message.kind, "inline_script");
    if (step.message.kind === "inline_script") {
      assert.equal(step.message.body, "cat report.txt");
      assert.equal(step.message.args, undefined);
    }
  }
});

test("log run inline script with args", () => {
  const mod = parsejaiph(
    'workflow default() {\n  log run `echo $1`("x")\n}',
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "say");
  if (step.type === "say" && step.message.kind === "inline_script") {
    assert.equal(step.message.body, "echo $1");
    assert.deepEqual(step.message.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("log bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default() {\n  log `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in log are not allowed/,
  );
});

test("logerr bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("workflow default() {\n  logerr `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in logerr are not allowed/,
  );
});

test("return bare identifier is sugar for interpolated literal", () => {
  const mod = parsejaiph(
    `workflow default() {\n  const response = "hello"\n  return response\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[1];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "literal") {
    assert.equal(step.value.raw, '"${response}"');
  }
});

test("return bare identifier in brace block (if body)", () => {
  const mod = parsejaiph(
    [
      "workflow default(name) {",
      '  const msg = "hi"',
      '  if name == "x" {',
      "    return msg",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const ifStep = mod.workflows[0].steps[1];
  assert.equal(ifStep.type, "if");
  if (ifStep.type === "if") {
    const retStep = ifStep.body[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return" && retStep.value.kind === "literal") {
      assert.equal(retStep.value.raw, '"${msg}"');
    }
  }
});

test("return bare identifier in catch/recover block", () => {
  const mod = parsejaiph(
    [
      "rule check() {",
      '  return "yes"',
      "}",
      "workflow default() {",
      "  ensure check() catch (err) {",
      "    return err",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const ensureStep = mod.workflows[0].steps[0];
  assert.equal(ensureStep.type, "exec");
  if (ensureStep.type === "exec" && ensureStep.body.kind === "ensure_call") {
    assert.ok(ensureStep.catch);
    const recoverSteps = "block" in ensureStep.catch! ? ensureStep.catch!.block : [ensureStep.catch!.single];
    const retStep = recoverSteps[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return" && retStep.value.kind === "literal") {
      assert.equal(retStep.value.raw, '"${err}"');
    }
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
      "  ensure check() catch (err) {",
      "    return run helper()",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const ensureStep = mod.workflows[0].steps[0];
  assert.equal(ensureStep.type, "exec");
  if (ensureStep.type === "exec" && ensureStep.body.kind === "ensure_call") {
    assert.ok(ensureStep.catch);
    const recoverSteps = "block" in ensureStep.catch! ? ensureStep.catch!.block : [ensureStep.catch!.single];
    const retStep = recoverSteps[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return" && retStep.value.kind === "call") {
      assert.equal(retStep.value.callee.value, "helper");
    }
  }
});
