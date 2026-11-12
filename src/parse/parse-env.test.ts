import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvDecl } from "./env";
import { BodyCursor } from "./body-cursor";

/** The cursor over `lines` and the position of 0-based line `idx`. */
function src(lines: string[], idx: number, filePath = "test.jh"): [BodyCursor, number] {
  return [BodyCursor.of(filePath, lines.join("\n")), lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0)];
}

test("parseEnvDecl: parses double-quoted single-line value", () => {
  const { envDecl, next } = parseEnvDecl(...src(['const FOO = "bar"'], 0));
  assert.equal(envDecl.name, "FOO");
  assert.equal(envDecl.value, "bar");
  assert.equal(next, src(['const FOO = "bar"'], 1)[1]);
});

test("parseEnvDecl: rejects single-quoted value", () => {
  assert.throws(
    () => parseEnvDecl(...src(["const NAME = 'hello'"], 0)),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: parses bare value", () => {
  const { envDecl } = parseEnvDecl(...src(["const COUNT = 42"], 0));
  assert.equal(envDecl.name, "COUNT");
  assert.equal(envDecl.value, "42");
});

test("parseEnvDecl: rejects multiline double-quoted value", () => {
  const lines = [
    'const MSG = "hello',
    'world"',
  ];
  assert.throws(
    () => parseEnvDecl(...src(lines, 0)),
    /multiline strings use triple quotes/,
  );
});

test("parseEnvDecl: parses triple-quoted multiline value", () => {
  const lines = [
    'const MSG = """',
    "hello",
    "world",
    '"""',
  ];
  const { envDecl, next } = parseEnvDecl(...src(lines, 0));
  assert.equal(envDecl.name, "MSG");
  assert.equal(envDecl.value, "hello\nworld");
  assert.equal(next, src(lines, 4)[1]);
});

test("parseEnvDecl: triple-quoted with interpolation", () => {
  const lines = [
    'const MSG = """',
    "  Hello ${name}",
    "  Done",
    '"""',
  ];
  const { envDecl } = parseEnvDecl(...src(lines, 0));
  assert.equal(envDecl.value, "  Hello ${name}\n  Done");
});

test("parseEnvDecl: rejects unclosed double-quoted string as multiline error", () => {
  assert.throws(
    () => parseEnvDecl(...src(['const X = "no close'], 0)),
    /multiline strings use triple quotes/,
  );
});

test("parseEnvDecl: rejects single-quoted string even if unterminated", () => {
  assert.throws(
    () => parseEnvDecl(...src(["const X = 'no close"], 0)),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: fails on content after closing double quote", () => {
  assert.throws(
    () => parseEnvDecl(...src(['const X = "val" extra'], 0)),
    /unexpected content after closing quote/,
  );
});

test("parseEnvDecl: rejects single-quoted string with trailing content", () => {
  assert.throws(
    () => parseEnvDecl(...src(["const X = 'val' extra"], 0)),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: fails on invalid declaration format", () => {
  assert.throws(
    () => parseEnvDecl(...src(["not a const"], 0)),
    /invalid declaration/,
  );
});

test("parseEnvDecl: rejects legacy local keyword", () => {
  assert.throws(
    () => parseEnvDecl(...src(['local X = "v"'], 0)),
    /invalid declaration/,
  );
});

test("parseEnvDecl: \\\" decodes to a quote; other backslashes stay", () => {
  const { envDecl } = parseEnvDecl(...src(['const X = "say \\"hi\\" \\d"'], 0));
  assert.equal(envDecl.name, "X");
  assert.equal(envDecl.value, 'say "hi" \\d');
  assert.equal(envDecl.tripleQuoted, undefined);
});
