import test from "node:test";
import assert from "node:assert/strict";
import { parseCallRef, parseMultilineCallArgList, parseNestedCallArg, parseParenArgs } from "./call-args";
import { literalText } from "./core";
import { BodyCursor } from "./body-cursor";

/** The cursor over `lines` and the position of 0-based line `idx`. */
function src(lines: string[], idx: number, filePath = "test.jh"): [BodyCursor, number] {
  return [BodyCursor.of(filePath, lines.join("\n")), lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0)];
}

test("call args: a comma inside a quoted argument stays in that argument", () => {
  assert.deepEqual(parseCallRef('foo("a, b", c)'), {
    ref: "foo",
    args: [
      { kind: "literal", raw: '"a, b"' },
      { kind: "var", name: "c" },
    ],
    rest: "",
  });
});

test("call args: a ) inside a quoted argument does not close the call", () => {
  assert.deepEqual(parseCallRef('foo("x)", "(y") tail'), {
    ref: "foo",
    args: [
      { kind: "literal", raw: '"x)"' },
      { kind: "literal", raw: '"(y"' },
    ],
    rest: " tail",
  });
});

test('call args: \\" inside an argument is kept in the stored form and decodes to a quote', () => {
  const call = parseCallRef('foo("say \\"hi\\", ok")');
  assert.ok(call?.args);
  assert.equal(call.args.length, 1);
  const arg = call.args[0]!;
  assert.equal(arg.kind, "literal");
  if (arg.kind !== "literal") return;
  assert.equal(arg.raw, '"say \\"hi\\", ok"');
  assert.equal(literalText(arg.raw), 'say "hi", ok');
});

test("call args: a nested call three levels deep is one argument and is recognized at each level", () => {
  const call = parseCallRef('foo(bar(baz(qux("x, y"), z)), last)');
  assert.ok(call?.args);
  assert.deepEqual(call.args, [
    { kind: "literal", raw: 'bar(baz(qux("x, y"), z))' },
    { kind: "var", name: "last" },
  ]);
  const one = parseNestedCallArg('bar(baz(qux("x, y"), z))');
  assert.equal(one?.kind, "call");
  if (one?.kind !== "call") return;
  assert.equal(one.ref, "bar");
  assert.deepEqual(one.args, [{ kind: "literal", raw: 'baz(qux("x, y"), z)' }]);
  const two = parseNestedCallArg('baz(qux("x, y"), z)');
  assert.ok(two?.kind === "call");
  assert.deepEqual(two.args, [
    { kind: "literal", raw: 'qux("x, y")' },
    { kind: "var", name: "z" },
  ]);
  const three = parseNestedCallArg('qux("x, y")');
  assert.ok(three?.kind === "call");
  assert.deepEqual(three.args, [{ kind: "literal", raw: '"x, y"' }]);
});

test("call args: nested inline scripts are recognized from tokens (with and without a tag)", () => {
  assert.deepEqual(parseNestedCallArg("'echo $1'(x) rest"), {
    kind: "inline_script",
    body: "echo $1",
    args: [{ kind: "var", name: "x" }],
    rest: " rest",
  });
  assert.deepEqual(parseNestedCallArg("python3'print(1)'()"), {
    kind: "inline_script",
    body: "print(1)",
    lang: "python3",
    args: [],
    rest: "",
  });
  assert.equal(parseNestedCallArg("'echo' (x)"), null, "a space between the script and ( is not a call");
  assert.equal(parseNestedCallArg('"quoted"'), null);
  assert.equal(parseNestedCallArg("${x}"), null);
});

test("call args: stray characters stay in a literal argument for the validator", () => {
  assert.deepEqual(parseCallRef("foo(a > b, #3)")?.args, [
    { kind: "literal", raw: "a > b" },
    { kind: "literal", raw: "#3" },
  ]);
});

test("call args: an unclosed call or string is not a one-line call", () => {
  assert.equal(parseCallRef('foo("a)'), null);
  assert.equal(parseCallRef("foo(a"), null);
  assert.equal(parseParenArgs("(a"), null);
  assert.deepEqual(parseParenArgs("(a, b) x"), {
    args: [
      { kind: "var", name: "a" },
      { kind: "var", name: "b" },
    ],
    rest: " x",
  });
});

test('call args: a """ argument may open on the call line or on its own line', () => {
  const onCallLine = ['  foo("""', "    hello", '  """, x)'];
  assert.deepEqual(parseMultilineCallArgList(...src(onCallLine, 0, "t.jh"), '"""'), {
    args: [
      { kind: "literal", raw: '"hello"' },
      { kind: "var", name: "x" },
    ],
    next: src(onCallLine, 3)[1],
    rest: "",
  });
  const ownLine = ["  foo(a,", '    """', '      say "hi"', "    \"\"\"", "  ) after"];
  assert.deepEqual(parseMultilineCallArgList(...src(ownLine, 0, "t.jh"), "a,"), {
    args: [
      { kind: "var", name: "a" },
      { kind: "literal", raw: '"say \\"hi\\""' },
    ],
    next: src(ownLine, 5)[1],
    rest: " after",
  });
});

test("call args: a missing ) in a multiline call is E_PARSE at the call line", () => {
  assert.throws(
    () => parseMultilineCallArgList(...src(["x", "  foo(a,", "    b"], 1, "t.jh"), "a,"),
    /t\.jh:2:1 E_PARSE unterminated multiline call — missing closing "\)"/,
  );
});
