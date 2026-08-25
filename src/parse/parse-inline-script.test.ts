import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("parser: run with backtick inline script", () => {
  const src = `
export def main() {
  run \`echo hello\`()
}
`;
  const ast = parsejaiph(src, "test.jh");
  assert.equal(ast.defs.length, 1);
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.equal(step.body.body, "echo hello");
    assert.equal(step.body.lang, undefined);
    assert.equal(step.body.args, undefined);
    assert.equal(step.captureName, undefined);
  }
});

test("parser: run with backtick inline script and args", () => {
  const src = `
export def main() {
  run \`echo $1\`("arg1", "arg2")
}
`;
  const ast = parsejaiph(src, "test.jh");
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.equal(step.body.body, "echo $1");
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"arg1"' },
      { kind: "literal", raw: '"arg2"' },
    ]);
  }
});

test("parser: capture form — x = run `body`() rejected without const", () => {
  const src = `
export def main() {
  x = run \`echo hello\`()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /assignment without "const"/);
});

test("parser: const capture form — const x = run `body`()", () => {
  const src = `
export def main() {
  const x = run \`echo hello\`()
}
`;
  const ast = parsejaiph(src, "test.jh");
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "const");
  if (step.type === "const" && step.value.kind === "inline_script") {
    assert.equal(step.value.body, "echo hello");
  }
});

test("parser: run script() with fenced block and lang tag", () => {
  const src = [
    "export def main() {",
    "  run ```python3",
    "print('hello')",
    "```()",
    "}",
  ].join("\n");
  const ast = parsejaiph(src, "test.jh");
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.equal(step.body.lang, "python3");
    assert.equal(step.body.body, "print('hello')");
  }
});

test("parser: run async with backtick inline script is rejected", () => {
  const src = `
export def main() {
  run async \`echo hello\`()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /not supported with inline scripts/);
});

test("parser: def body supports multiline fenced run ```", () => {
  const src = [
    "def check(name) {",
    "  run ```",
    "    if [ -z \"$1\" ]; then",
    "      echo fail >&2",
    "      exit 1",
    "    fi",
    "  ```(name)",
    "}",
    "export def main() {",
    "  run check()",
    "}",
  ].join("\n");
  const ast = parsejaiph(src, "test.jh");
  const check = ast.defs.find((w) => w.name === "check");
  assert.ok(check);
  const step = check.steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.ok(step.body.body.includes('if [ -z "$1" ]'));
    assert.deepEqual(step.body.args, [{ kind: "var", name: "name" }]);
  }
});

test("parser: if keyword with old syntax in def produces E_PARSE", () => {
  const src = [
    'script ok = `true`',
    "def r() {",
    "  if run ok() {",
    "    run ```",
    "echo in-branch",
    "```()",
    "  }",
    "}",
    "export def main() {",
    "  run r()",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /invalid if syntax/,
  );
});

test("parser: old run script() syntax is rejected", () => {
  const src = `
export def main() {
  run script()
}
`;
  assert.throws(() => parsejaiph(src, "test.jh"), /inline script syntax has changed/);
});
