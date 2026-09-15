import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

/** Parse a def body line and return its single exec step. */
function execStepOf(line: string) {
  const src = ["export def main(content) {", `  ${line}`, "}"].join("\n");
  const mod = parsejaiph(src, "test.jh");
  return mod.defs[0]!.steps[0]!;
}

test("parse: run ref(args) stdin <bare ident> binds a quoted-interp literal", () => {
  const step = execStepOf("run save(path) stdin content");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "call");
  assert.ok(step.stdin, "stdin clause present");
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: run ref() stdin <quoted string> keeps the literal verbatim", () => {
  const step = execStepOf('run save(path) stdin "hello ${content}"');
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"hello ${content}"' });
});

test("parse: run ref() stdin ${x} interpolation ref is quoted", () => {
  const step = execStepOf("run save(path) stdin ${content}");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: stdin sits before catch and both are captured", () => {
  const src = [
    "export def main(content) {",
    "  run save(path) stdin content catch (e) {",
    '    fail "boom"',
    "  }",
    "}",
  ].join("\n");
  const step = parsejaiph(src, "test.jh").defs[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
  assert.ok(step.catch, "catch clause present");
});

test("parse: stdin sits before recover and both are captured", () => {
  const src = [
    "export def main(content) {",
    "  run save(path) stdin content recover (e) {",
    '    logwarn "retry"',
    "  }",
    "}",
  ].join("\n");
  const step = parsejaiph(src, "test.jh").defs[0]!.steps[0]!;
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
  assert.ok(step.recover, "recover clause present");
});

test("parse: stdin on an inline script", () => {
  const step = execStepOf("run `cat`() stdin content");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "inline_script");
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: run async ... stdin is E_PARSE", () => {
  assert.throws(
    () => execStepOf("run async save(path) stdin content"),
    /stdin is not supported with run async/,
  );
});

test("parse: run ref(args) stdin content > file stays E_PARSE (trailing redirect)", () => {
  assert.throws(
    () => execStepOf("run save(path) stdin content > out.txt"),
    /unexpected content/i,
  );
});

test("parse: stdin without a value is E_PARSE", () => {
  assert.throws(
    () => execStepOf("run save(path) stdin"),
    /stdin requires a value expression/,
  );
});

test("parse: run ref() with no stdin leaves the field unset", () => {
  const step = execStepOf("run save(path)");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.stdin, undefined);
});
