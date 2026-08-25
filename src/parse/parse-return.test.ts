import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("return run parses Expr.call", () => {
  const mod = parsejaiph(
    `export def main() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    `export def main() {\n  return run helper("a", "b")\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    `export def main() {\n  return run lib.helper()\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "lib.helper");
  }
});

test("return run parses Expr.call", () => {
  const mod = parsejaiph(
    `export def main() {\n  return run check()\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "call");
    if (step.value.kind === "call") {
      assert.equal(step.value.callee.value, "check");
      assert.equal(step.value.args, undefined);
    }
  }
});

test("return run parses Expr.call with args", () => {
  const mod = parsejaiph(
    `export def main() {\n  return run check("x")\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.deepEqual(step.value.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("return run in rule parses Expr.call", () => {
  const mod = parsejaiph(
    `script helper = \`echo "ok"\`\ndef my_rule() {\n  return run helper()\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "call") {
    assert.equal(step.value.callee.value, "helper");
  }
});

test("return run in rule parses Expr.call", () => {
  const mod = parsejaiph(
    `def sub_rule() {\n  return "ok"\n}\ndef my_rule() {\n  return run sub_rule()\n}`,
    "test.jh",
  );
  const myRule = mod.defs.find(r => r.name === "my_rule")!;
  const retStep = myRule.steps[0];
  assert.equal(retStep.type, "return");
  if (retStep.type === "return" && retStep.value.kind === "call") {
    assert.equal(retStep.value.callee.value, "sub_rule");
  }
});

test("return with string value is Expr.literal", () => {
  const mod = parsejaiph(
    `export def main() {\n  return "hello"\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    `export def main() {\n  return\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    "export def main() {\n  return run `cat report.txt`()\n}",
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    'export def main() {\n  return run `echo $1`("x")\n}',
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "inline_script") {
    assert.equal(step.value.body, "echo $1");
    assert.deepEqual(step.value.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("return bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  return `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in return are not allowed/,
  );
});

test("log run inline script parses say with inline_script message", () => {
  const mod = parsejaiph(
    "export def main() {\n  log run `cat report.txt`()\n}",
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
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
    'export def main() {\n  log run `echo $1`("x")\n}',
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "say");
  if (step.type === "say" && step.message.kind === "inline_script") {
    assert.equal(step.message.body, "echo $1");
    assert.deepEqual(step.message.args, [{ kind: "literal", raw: '"x"' }]);
  }
});

test("log bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  log `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in log are not allowed/,
  );
});

test("logerr bare inline script is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  logerr `cat report.txt`()\n}", "test.jh"),
    /bare inline scripts in logerr are not allowed/,
  );
});

test("return bare identifier is sugar for interpolated literal", () => {
  const mod = parsejaiph(
    `export def main() {\n  const response = "hello"\n  return response\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[1];
  assert.equal(step.type, "return");
  if (step.type === "return" && step.value.kind === "literal") {
    assert.equal(step.value.raw, '"${response}"');
  }
});

test("return bare identifier in brace block (if body)", () => {
  const mod = parsejaiph(
    [
      "export def main(name) {",
      '  const msg = "hi"',
      '  if name == "x" {',
      "    return msg",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const ifStep = mod.defs[0].steps[1];
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
      "def check() {",
      '  return "yes"',
      "}",
      "export def main() {",
      "  run check() catch (err) {",
      "    return err",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const main = mod.defs.find((w) => w.name === "main")!;
  const ensureStep = main.steps[0];
  assert.equal(ensureStep.type, "exec");
  if (ensureStep.type === "exec" && ensureStep.body.kind === "call") {
    assert.ok(ensureStep.catch);
    const recoverSteps = "block" in ensureStep.catch! ? ensureStep.catch!.block : [ensureStep.catch!.single];
    const retStep = recoverSteps[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return" && retStep.value.kind === "literal") {
      assert.equal(retStep.value.raw, '"${err}"');
    }
  }
});

test("return run in run recover block", () => {
  const mod = parsejaiph(
    [
      'script helper = `echo "ok"`',
      "def check() {",
      '  return "yes"',
      "}",
      "export def main() {",
      "  run check() catch (err) {",
      "    return run helper()",
      "  }",
      "}",
    ].join("\n"),
    "test.jh",
  );
  const main = mod.defs.find((w) => w.name === "main")!;
  const ensureStep = main.steps[0];
  assert.equal(ensureStep.type, "exec");
  if (ensureStep.type === "exec" && ensureStep.body.kind === "call") {
    assert.ok(ensureStep.catch);
    const recoverSteps = "block" in ensureStep.catch! ? ensureStep.catch!.block : [ensureStep.catch!.single];
    const retStep = recoverSteps[0];
    assert.equal(retStep.type, "return");
    if (retStep.type === "return" && retStep.value.kind === "call") {
      assert.equal(retStep.value.callee.value, "helper");
    }
  }
});
