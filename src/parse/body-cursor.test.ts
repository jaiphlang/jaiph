import test from "node:test";
import assert from "node:assert/strict";
import { BodyCursor, keyOf, tokenizeLine, topLevelKeyword } from "./body-cursor";

const kinds = (cursor: BodyCursor, idx: number): string[] => cursor.tokens(idx).map((t) => `${t.kind}:${t.text}`);

test("BodyCursor: a line's tokens stop at its newline, with absolute positions", () => {
  const lines = ["def w() {", '  log "hi"', "}"];
  const cursor = BodyCursor.of("w.jh", lines);
  assert.deepEqual(kinds(cursor, 1), ["ident:log", 'string:"hi"']);
  const [log] = cursor.tokens(1);
  assert.equal(log!.line, 2);
  assert.equal(log!.col, 3);
  assert.equal(log!.offset, "def w() {\n  ".length);
  assert.deepEqual(cursor.tokens(3 - 1).map((t) => t.text), ["}"]);
});

test("BodyCursor: a block that opens on a line is one token, and the closer line's tail belongs to it", () => {
  const lines = ['  send """', "    body", '  """ -> ch', "  return x"];
  const cursor = BodyCursor.of("w.jh", lines);
  const toks = cursor.tokens(0);
  assert.deepEqual(toks.map((t) => t.kind), ["ident", "triple_string", "punct", "ident"]);
  assert.equal(BodyCursor.endLineIdx(toks[1]!), 2);
  assert.equal(cursor.textAfter(toks[1]!), " -> ch");
});

test("BodyCursor: malformed text ends the line as one `other` token", () => {
  const cursor = BodyCursor.of("w.jh", ['  log "unterminated', "  x'no close"]);
  assert.deepEqual(kinds(cursor, 0), ["ident:log", 'other:"unterminated']);
  const [head] = cursor.tokens(1);
  assert.equal(head!.kind, "other");
  assert.equal(head!.col, 3);
  assert.equal(keyOf(head), "x");
});

test("BodyCursor: one cursor per lines array and file", () => {
  const lines = ["a()"];
  assert.equal(BodyCursor.of("a.jh", lines), BodyCursor.of("a.jh", lines));
  assert.notEqual(BodyCursor.of("a.jh", lines), BodyCursor.of("b.jh", lines));
});

test("keyOf: the identifier a statement starts with", () => {
  const cursor = BodyCursor.of("w.jh", ["log'echo'()", "if x", '"s"', "1x"]);
  assert.equal(keyOf(cursor.tokens(0)[0]), "log");
  assert.equal(keyOf(cursor.tokens(1)[0]), "if");
  assert.equal(keyOf(cursor.tokens(2)[0]), undefined);
  assert.equal(keyOf(cursor.tokens(3)[0]), undefined);
});

const lineKinds = (cursor: BodyCursor, idx: number): string[] =>
  cursor.lineTokensOf(idx).map((t) => `${t.kind}:${t.text}`);

test("lineTokensOf: a block opener stays one token on its own line", () => {
  const lines = ['const x = """', "  body", '"""', "script s = py'''", "print(1)", "'''"];
  const cursor = BodyCursor.of("m.jh", lines);
  assert.deepEqual(lineKinds(cursor, 0), ["ident:const", "ident:x", "punct:=", 'other:"""']);
  assert.deepEqual(lineKinds(cursor, 3), ["ident:script", "ident:s", "punct:=", "other:py'''"]);
  const opener = cursor.lineTokensOf(3)[3]!;
  assert.equal(opener.offset, cursor.offset(3, opener.col));
});

test("lineTokensOf: lexing resumes after the lexeme it stopped at", () => {
  const cursor = BodyCursor.of("m.jh", [`import 'x" as y`, "f(`a`, z'q)"]);
  assert.deepEqual(lineKinds(cursor, 0), ["ident:import", "other:'", "ident:x", 'other:"', "ident:as", "ident:y"]);
  assert.deepEqual(lineKinds(cursor, 1), [
    "ident:f", "punct:(", "other:`", "ident:a", "other:`", "punct:,", "other:z'", "ident:q", "punct:)",
  ]);
});

test("topLevelKeyword: the declaration a line starts with", () => {
  const keyword = (line: string): string | undefined => topLevelKeyword(tokenizeLine("m.jh", line, 1), line);
  assert.equal(keyword('import script "a.py" as a'), "import script");
  assert.equal(keyword('import "a.jh" as a'), "import");
  assert.equal(keyword('import\t"a.jh" as a'), undefined);
  assert.equal(keyword("config{"), "config");
  assert.equal(keyword("export  def w() {"), "def");
  assert.equal(keyword("const 1 = x"), undefined);
  assert.equal(keyword("script"), undefined);
});

test("rawBodyAfter: the shell body of a mock script, up to its closing line", () => {
  const lines = ["  mock script a.b() {", "    echo hi", "  }", "  mock script c() {", "  }", "  mock script d() {"];
  const cursor = BodyCursor.of("t.test.jh", lines);
  assert.deepEqual(cursor.rawBodyAfter(0), { body: "    echo hi", closeIdx: 2 });
  assert.deepEqual(cursor.rawBodyAfter(3), { body: "", closeIdx: 4 });
  assert.equal(cursor.rawBodyAfter(5), null);
});
