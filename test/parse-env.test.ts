import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvDecl } from "../src/parse/env";

test("parseEnvDecl: parses double-quoted single-line value", () => {
  const { envDecl, nextIndex } = parseEnvDecl("test.jh", ['local FOO = "bar"'], 0);
  assert.equal(envDecl.name, "FOO");
  assert.equal(envDecl.value, "bar");
  assert.equal(nextIndex, 1);
});

test("parseEnvDecl: parses single-quoted value", () => {
  const { envDecl, nextIndex } = parseEnvDecl("test.jh", ["local NAME = 'hello'"], 0);
  assert.equal(envDecl.name, "NAME");
  assert.equal(envDecl.value, "hello");
  assert.equal(nextIndex, 1);
});

test("parseEnvDecl: parses bare value", () => {
  const { envDecl } = parseEnvDecl("test.jh", ["local COUNT = 42"], 0);
  assert.equal(envDecl.name, "COUNT");
  assert.equal(envDecl.value, "42");
});

test("parseEnvDecl: parses multiline double-quoted value", () => {
  const lines = [
    'local MSG = "hello',
    'world"',
  ];
  const { envDecl, nextIndex } = parseEnvDecl("test.jh", lines, 0);
  assert.equal(envDecl.name, "MSG");
  assert.equal(envDecl.value, "hello\nworld");
  assert.equal(nextIndex, 2);
});

test("parseEnvDecl: fails on unterminated double-quoted string", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ['local X = "no close'], 0),
    /unterminated string/,
  );
});

test("parseEnvDecl: fails on unterminated single-quoted string", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["local X = 'no close"], 0),
    /unterminated string/,
  );
});

test("parseEnvDecl: fails on content after closing double quote", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ['local X = "val" extra'], 0),
    /unexpected content after closing quote/,
  );
});

test("parseEnvDecl: fails on content after closing single quote", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["local X = 'val' extra"], 0),
    /unexpected content after closing quote/,
  );
});

test("parseEnvDecl: fails on invalid declaration format", () => {
  assert.throws(
    () => parseEnvDecl("test.jh", ["not a local"], 0),
    /invalid declaration/,
  );
});

test("parseEnvDecl: handles escaped quotes in double-quoted value", () => {
  const { envDecl } = parseEnvDecl("test.jh", ['local X = "say \\"hi\\""'], 0);
  assert.equal(envDecl.name, "X");
  assert.equal(envDecl.value, 'say \\"hi\\"');
});
