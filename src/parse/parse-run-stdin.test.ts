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
  const step = stepOf("stdin content -> 'cat'()");
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

test("parse: stdin foo() -> bar() one-hop call producer pins the AST", () => {
  const step = stepOf("stdin foo() -> bar()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "call", callee: { value: "foo", loc: { line: 2, col: 3 } } });
  assert.equal(step.body.kind, "call");
  if (step.body.kind === "call") assert.equal(step.body.callee.value, "bar");
  assert.equal(step.stages, undefined, "no intermediate stages on a one-hop pipeline");
});

test("parse: stdin wrap() -> bar() def producer parses the same shape as a script producer", () => {
  const step = stepOf("stdin wrap() -> bar()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  // Producer kind (def vs script) is a validate-time concern; the AST is a call.
  assert.deepEqual(step.stdin, { kind: "call", callee: { value: "wrap", loc: { line: 2, col: 3 } } });
});

test("parse: stdin foo() -> bar() -> baz() pins producer, one middle stage, and body", () => {
  const step = stepOf("stdin foo() -> bar() -> baz()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.stdin?.kind, "call");
  if (step.stdin?.kind === "call") assert.equal(step.stdin.callee.value, "foo");
  assert.equal(step.stages?.length, 1);
  const mid = step.stages?.[0];
  assert.equal(mid?.kind, "call");
  if (mid?.kind === "call") assert.equal(mid.callee.value, "bar");
  assert.equal(step.body.kind, "call");
  if (step.body.kind === "call") assert.equal(step.body.callee.value, "baz");
});

test("parse: stdin content -> bar() -> baz() value producer with a middle stage is a pipeline", () => {
  const step = stepOf("stdin content -> bar() -> baz()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.deepEqual(step.stdin, { kind: "literal", raw: '"${content}"' });
  assert.equal(step.stages?.length, 1);
  if (step.stages?.[0]?.kind === "call") assert.equal(step.stages[0].callee.value, "bar");
});

test("parse: stdin foo() with no arrow is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin foo()"),
    /stdin requires '-> ref\(\)'/,
  );
});

test("parse: recover on a one-hop pipeline is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin foo() -> bar() recover (e) { log e }"),
    /recover is not supported on a stdin pipeline/,
  );
});

test("parse: recover on a three-stage pipeline is E_PARSE", () => {
  assert.throws(
    () => stepOf("stdin foo() -> bar() -> baz() recover (e) { log e }"),
    /recover is not supported on a stdin pipeline/,
  );
});

test("parse: catch on a pipeline is allowed (one-shot)", () => {
  const step = stepOf("stdin foo() -> bar() catch (e) { log e }");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.ok(step.catch, "catch clause present on a pipeline");
  assert.equal(step.recover, undefined);
});

test("parse: inline-script producer and stages round-trip through the AST", () => {
  const step = stepOf("stdin 'gen'() -> 'tr a-z A-Z'()");
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.stdin?.kind, "inline_script");
  if (step.stdin?.kind === "inline_script") assert.equal(step.stdin.body, "gen");
  assert.equal(step.body.kind, "inline_script");
  if (step.body.kind === "inline_script") assert.equal(step.body.body, "tr a-z A-Z");
});
