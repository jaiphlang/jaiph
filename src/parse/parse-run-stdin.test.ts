import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

/** Parse a def body line and return its single step. */
function stepOf(line: string) {
  const src = ["export def main(content) {", `  ${line}`, "}"].join("\n");
  const mod = parsejaiph(src, "test.jh");
  return mod.defs[0]!.steps[0]!;
}

test("parse: stdin <bare ident> -> ref() binds a quoted-interp literal", () => {
  const step = stepOf("stdin content -> save(path)");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "call");
  assert.ok(step.stdin, "stdin bound");
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: stdin \"...\" -> ref() keeps the literal verbatim", () => {
  const step = stepOf('stdin "hello ${content}" -> save(path)');
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"hello ${content}"' });
});

test("parse: stdin ${x} -> ref() interpolation ref is quoted", () => {
  const step = stepOf("stdin ${content} -> save(path)");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: stdin -> ref() with attached catch captures both", () => {
  const src = [
    "export def main(content) {",
    "  stdin content -> save(path) catch (e) {",
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

test("parse: stdin -> ref() with attached recover captures both", () => {
  const src = [
    "export def main(content) {",
    "  stdin content -> save(path) recover (e) {",
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

test("parse: stdin -> inline script", () => {
  const step = stepOf("stdin content -> `cat`()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "inline_script");
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: const out = stdin content -> ref() captures into out", () => {
  const step = stepOf("const out = stdin content -> save(path)");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.captureName, "out");
  assert.equal(step.body.kind, "call");
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
});

test("parse: stdin -> async ref() is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin content -> async save(path)"),
    /async is not supported with stdin/,
  );
});

test("parse: async stdin is E_PARSE", () => {
  assert.throws(
    () => stepOf("async stdin content -> save(path)"),
    /async is not supported with stdin/,
  );
});

test("parse: stdin without a value is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin"),
    /stdin requires a value expression/,
  );
});

test("parse: stdin value without an arrow is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin content save(path)"),
    /stdin requires '-> ref\(\)'/,
  );
});
