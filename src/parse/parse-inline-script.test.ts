import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parser: run with backtick inline script", () => {
  const src = `
workflow default() {
  run \`echo hello\`()
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

test("parser: run with backtick inline script and args", () => {
  const src = `
workflow default() {
  run \`echo $1\`("arg1", "arg2")
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

test("parser: capture form — x = run `body`()", () => {
  const src = `
workflow default() {
  x = run \`echo hello\`()
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

test("parser: const capture form — const x = run `body`()", () => {
  const src = `
workflow default() {
  const x = run \`echo hello\`()
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
    "  run ```python3",
    "print('hello')",
    "```()",
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

test("parser: run async with backtick inline script is rejected", () => {
  const src = `
workflow default() {
  run async \`echo hello\`()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /not supported with inline scripts/);
});

test("parser: rule body supports multiline fenced run ```", () => {
  const src = [
    "rule check(name) {",
    "  run ```",
    "    if [ -z \"$1\" ]; then",
    "      echo fail >&2",
    "      exit 1",
    "    fi",
    "  ```(name)",
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
    assert.deepEqual(step.bareIdentifierArgs, ["name"]);
  }
});

test("parser: if keyword in rule produces E_PARSE", () => {
  const src = [
    'script ok = `true`',
    "rule r() {",
    "  if run ok() {",
    "    run ```",
    "echo in-branch",
    "```()",
    "  }",
    "}",
    "workflow default() {",
    "  ensure r()",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /if statements have been removed/,
  );
});

test("parser: old run script() syntax is rejected", () => {
  const src = `
workflow default() {
  run script()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /inline script syntax has changed/);
});
