import test from "node:test";
import assert from "node:assert/strict";
import { BodyCursor, keyOf, tokenizeLine, topLevelKeyword } from "./body-cursor";

/** A cursor over `lines` joined with newlines. */
const cursorOf = (filePath: string, lines: string[]): BodyCursor => BodyCursor.of(filePath, lines.join("\n"));
/** Position (source offset) of 0-based line `idx` of `lines`. */
const lineAt = (lines: string[], idx: number): number => lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);

const kinds = (cursor: BodyCursor, at: number): string[] => cursor.tokens(at).map((t) => `${t.kind}:${t.text}`);

test("BodyCursor: a line's tokens stop at its newline, with absolute positions", () => {
  const lines = ["def w() {", '  log "hi"', "}"];
  const cursor = cursorOf("w.jh", lines);
  assert.deepEqual(kinds(cursor, lineAt(lines, 1)), ["ident:log", 'string:"hi"']);
  const [log] = cursor.tokens(lineAt(lines, 1));
  assert.equal(log!.line, 2);
  assert.equal(log!.col, 3);
  assert.equal(log!.offset, "def w() {\n  ".length);
  assert.deepEqual(cursor.tokens(lineAt(lines, 2)).map((t) => t.text), ["}"]);
});

test("BodyCursor: a block that opens on a line is one token, and the closer line's tail belongs to it", () => {
  const lines = ['  send """', "    body", '  """ -> ch', "  return x"];
  const cursor = cursorOf("w.jh", lines);
  const toks = cursor.tokens(0);
  assert.deepEqual(toks.map((t) => t.kind), ["ident", "triple_string", "punct", "ident"]);
  assert.equal(cursor.closeOf(toks[1]!), lineAt(lines, 2));
  assert.equal(cursor.textAfter(toks[1]!), " -> ch");
});

test("BodyCursor: malformed text ends the line as one `other` token", () => {
  const lines = ['  log "unterminated', "  x'no close"];
  const cursor = cursorOf("w.jh", lines);
  assert.deepEqual(kinds(cursor, 0), ["ident:log", 'other:"unterminated']);
  const [head] = cursor.tokens(lineAt(lines, 1));
  assert.equal(head!.kind, "other");
  assert.equal(head!.col, 3);
  assert.equal(keyOf(head), "x");
});

test("BodyCursor: positions are line starts; lineNo, text and next walk the source", () => {
  const cursor = BodyCursor.of("w.jh", "a\n\nbc\n");
  const seen: Array<[number, number, string]> = [];
  for (let at = 0; !cursor.atEnd(at); at = cursor.next(at)) seen.push([at, cursor.lineNo(at), cursor.text(at)]);
  assert.deepEqual(seen, [[0, 1, "a"], [2, 2, ""], [3, 3, "bc"], [6, 4, ""]]);
  assert.equal(cursor.next(6), 7);
  assert.equal(cursor.atEnd(7), true);
  assert.equal(cursor.lineNo(7), 5);
  assert.equal(cursor.text(7), "");
  assert.equal(cursor.lineStartAt(4), 3);
  assert.equal(BodyCursor.of("w.jh", "\nx").lineStartAt(0), 0);
});

test("keyOf: the identifier a statement starts with", () => {
  const lines = ["log'echo'()", "if x", '"s"', "1x"];
  const cursor = cursorOf("w.jh", lines);
  assert.equal(keyOf(cursor.tokens(lineAt(lines, 0))[0]), "log");
  assert.equal(keyOf(cursor.tokens(lineAt(lines, 1))[0]), "if");
  assert.equal(keyOf(cursor.tokens(lineAt(lines, 2))[0]), undefined);
  assert.equal(keyOf(cursor.tokens(lineAt(lines, 3))[0]), undefined);
});

const lineKinds = (cursor: BodyCursor, at: number): string[] =>
  cursor.lineTokensOf(at).map((t) => `${t.kind}:${t.text}`);

test("lineTokensOf: a block opener stays one token on its own line", () => {
  const lines = ['const x = """', "  body", '"""', "script s = py'''", "print(1)", "'''"];
  const cursor = cursorOf("m.jh", lines);
  assert.deepEqual(lineKinds(cursor, 0), ["ident:const", "ident:x", "punct:=", 'other:"""']);
  assert.deepEqual(lineKinds(cursor, lineAt(lines, 3)), ["ident:script", "ident:s", "punct:=", "other:py'''"]);
  const opener = cursor.lineTokensOf(lineAt(lines, 3))[3]!;
  assert.equal(opener.offset, lineAt(lines, 3) + opener.col - 1);
});

test("lineTokensOf: lexing resumes after the lexeme it stopped at", () => {
  const lines = [`import 'x" as y`, "f(`a`, z'q)"];
  const cursor = cursorOf("m.jh", lines);
  assert.deepEqual(lineKinds(cursor, 0), ["ident:import", "other:'", "ident:x", 'other:"', "ident:as", "ident:y"]);
  assert.deepEqual(lineKinds(cursor, lineAt(lines, 1)), [
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
  const cursor = cursorOf("t.test.jh", lines);
  assert.deepEqual(cursor.rawBodyAfter(0), { body: "    echo hi", closeAt: lineAt(lines, 2) });
  assert.deepEqual(cursor.rawBodyAfter(lineAt(lines, 3)), { body: "", closeAt: lineAt(lines, 4) });
  assert.equal(cursor.rawBodyAfter(lineAt(lines, 5)), null);
});
