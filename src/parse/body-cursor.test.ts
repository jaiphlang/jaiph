import test from "node:test";
import assert from "node:assert/strict";
import { BodyCursor, keyOf } from "./body-cursor";

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
