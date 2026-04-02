import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parser: run script() with quoted body", () => {
  const src = `
workflow default() {
  run script() "echo hello"
}
`;
  const ast = parsejaiph(src, "test.jh");
  assert.equal(ast.workflows.length, 1);
  const step = ast.workflows[0].steps[0];
  assert.equal(step.type, "run_inline_script");
  if (step.type === "run_inline_script") {
    assert.equal(step.body, "echo hello");
    assert.equal(step.lang, undefined);
    assert.equal(step.args, undefined);
    assert.equal(step.captureName, undefined);
  }
});

test("parser: run script() with args and body", () => {
  const src = `
workflow default() {
  run script("arg1", "arg2") "echo $1"
}
`;
  const ast = parsejaiph(src, "test.jh");
  const step = ast.workflows[0].steps[0];
  assert.equal(step.type, "run_inline_script");
  if (step.type === "run_inline_script") {
    assert.equal(step.body, "echo $1");
    assert.equal(step.args, '"arg1" "arg2"');
  }
});

test("parser: capture form — x = run script() body", () => {
  const src = `
workflow default() {
  x = run script() "echo hello"
}
`;
  const ast = parsejaiph(src, "test.jh");
  const step = ast.workflows[0].steps[0];
  assert.equal(step.type, "run_inline_script");
  if (step.type === "run_inline_script") {
    assert.equal(step.body, "echo hello");
    assert.equal(step.captureName, "x");
  }
});

test("parser: const capture form — const x = run script() body", () => {
  const src = `
workflow default() {
  const x = run script() "echo hello"
}
`;
  const ast = parsejaiph(src, "test.jh");
  const step = ast.workflows[0].steps[0];
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "run_inline_script_capture");
    if (step.value.kind === "run_inline_script_capture") {
      assert.equal(step.value.body, "echo hello");
    }
  }
});

test("parser: run script() with fenced block and lang tag", () => {
  const src = [
    "workflow default() {",
    "  run script() ```python3",
    "print('hello')",
    "```",
    "}",
  ].join("\n");
  const ast = parsejaiph(src, "test.jh");
  const step = ast.workflows[0].steps[0];
  assert.equal(step.type, "run_inline_script");
  if (step.type === "run_inline_script") {
    assert.equal(step.lang, "python3");
    assert.equal(step.body, "print('hello')");
  }
});

test("parser: run async script() is rejected", () => {
  const src = `
workflow default() {
  run async script() "echo hello"
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /not supported with inline scripts/);
});

test("parser: rule body supports multiline fenced run script()", () => {
  const src = [
    "rule check(name) {",
    "  run script(name) ```",
    "    if [ -z \"$1\" ]; then",
    "      echo fail >&2",
    "      exit 1",
    "    fi",
    "  ```",
    "}",
    "workflow default() {",
    "  ensure check()",
    "}",
  ].join("\n");
  const ast = parsejaiph(src, "test.jh");
  assert.equal(ast.rules.length, 1);
  const step = ast.rules[0].steps[0];
  assert.equal(step.type, "run_inline_script");
  if (step.type === "run_inline_script") {
    assert.ok(step.body.includes('if [ -z "$1" ]'));
    assert.equal(step.args, "${name}");
  }
});

test("parser: rule brace-if body supports fenced run script()", () => {
  const src = [
    "script ok = \"true\"",
    "rule r() {",
    "  if run ok() {",
    "    run script() ```",
    "echo in-branch",
    "```",
    "  }",
    "}",
    "workflow default() {",
    "  ensure r()",
    "}",
  ].join("\n");
  const ast = parsejaiph(src, "test.jh");
  const ifStep = ast.rules[0].steps[0];
  assert.equal(ifStep.type, "if");
  if (ifStep.type === "if") {
    const inner = ifStep.thenSteps[0];
    assert.equal(inner.type, "run_inline_script");
    if (inner.type === "run_inline_script") {
      assert.equal(inner.body.trim(), "echo in-branch");
    }
  }
});

test("parser: run script() requires body after parens", () => {
  const src = `
workflow default() {
  run script()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /inline script body is required/);
});
