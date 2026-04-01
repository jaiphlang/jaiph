import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvDecl } from "./env";

test("parseEnvDecl: parses double-quoted single-line value", () => {
  const { envDecl, nextIndex } = parseEnvDecl("test.jh", ['const FOO = "bar"'], 0);
  assert.equal(envDecl.name, "FOO");
  assert.equal(envDecl.value, "bar");
  assert.equal(nextIndex, 1);
});

test("parseEnvDecl: rejects single-quoted value", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["const NAME = 'hello'"], 0),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: parses bare value", () => {
  const { envDecl } = parseEnvDecl("test.jh", ["const COUNT = 42"], 0);
  assert.equal(envDecl.name, "COUNT");
  assert.equal(envDecl.value, "42");
});

test("parseEnvDecl: parses multiline double-quoted value", () => {
  const lines = [
    'const MSG = "hello',
    'world"',
  ];
  const { envDecl, nextIndex } = parseEnvDecl("test.jh", lines, 0);
  assert.equal(envDecl.name, "MSG");
  assert.equal(envDecl.value, "hello\nworld");
  assert.equal(nextIndex, 2);
});

test("parseEnvDecl: fails on unterminated double-quoted string", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ['const X = "no close'], 0),
    /unterminated string/,
  );
});

test("parseEnvDecl: rejects single-quoted string even if unterminated", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["const X = 'no close"], 0),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: fails on content after closing double quote", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ['const X = "val" extra'], 0),
    /unexpected content after closing quote/,
  );
});

test("parseEnvDecl: rejects single-quoted string with trailing content", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["const X = 'val' extra"], 0),
    /single-quoted strings are not supported/,
  );
});

test("parseEnvDecl: fails on invalid declaration format", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["not a const"], 0),
    /invalid declaration/,
  );
});

test("parseEnvDecl: rejects legacy local keyword", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ['local X = "v"'], 0),
    /invalid declaration/,
  );
});

test("parseEnvDecl: handles escaped quotes in double-quoted value", () => {
  const { envDecl } = parseEnvDecl("test.jh", ['const X = "say \\"hi\\""'], 0);
  assert.equal(envDecl.name, "X");
  assert.equal(envDecl.value, 'say \\"hi\\"');
});
