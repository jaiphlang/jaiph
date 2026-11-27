import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  decodeCallArgLiteral,
  interpolate,
  sanitizeName,
  stripOuterQuotes,
} from "./runtime-arg-parser";

describe("decodeCallArgLiteral", () => {
  it("strips quote delimiters wherever they open/close", () => {
    assert.equal(decodeCallArgLiteral('"hello world"'), "hello world");
    assert.equal(decodeCallArgLiteral('name="b c"'), "name=b c");
  });

  it("keeps an empty literal empty", () => {
    assert.equal(decodeCallArgLiteral('""'), "");
  });

  it("preserves special bytes inside quotes (commas, parens, spaces)", () => {
    assert.equal(decodeCallArgLiteral('"a )b, c"'), "a )b, c");
  });

  it("decodes the one escape (\\\") and leaves ${…} for later interpolation", () => {
    assert.equal(decodeCallArgLiteral('"q\\"r"'), 'q"r');
    assert.equal(decodeCallArgLiteral("${x}"), "${x}");
  });
});

describe("sanitizeName", () => {
  it("preserves alphanumeric, _, -, .", () => {
    assert.equal(sanitizeName("abc_123.def-ghi"), "abc_123.def-ghi");
  });

  it("replaces unsafe chars with underscore", () => {
    assert.equal(sanitizeName("foo/bar baz"), "foo_bar_baz");
    assert.equal(sanitizeName("a:b@c#d"), "a_b_c_d");
  });
});

describe("interpolate", () => {
  it("substitutes ${var} from the vars map", () => {
    const vars = new Map([["name", "world"]]);
    assert.equal(interpolate("hello ${name}", vars), "hello world");
  });

  it("falls back to env when var is not in scope", () => {
    const vars = new Map<string, string>();
    assert.equal(interpolate("home=${HOME}", vars, { HOME: "/tmp" }), "home=/tmp");
  });

  it("returns empty string for missing identifiers", () => {
    assert.equal(interpolate("[${missing}]", new Map()), "[]");
  });

  it("supports ${var.field} JSON dot access", () => {
    const vars = new Map([["user", JSON.stringify({ name: "Adam", age: 30 })]]);
    assert.equal(interpolate("hi ${user.name}, age ${user.age}", vars), "hi Adam, age 30");
  });

  it("returns empty string for ${var.field} when base is not JSON", () => {
    const vars = new Map([["bad", "not-json"]]);
    assert.equal(interpolate("[${bad.field}]", vars), "[]");
  });
});

describe("stripOuterQuotes", () => {
  it('removes matching double quotes', () => {
    assert.equal(stripOuterQuotes('"hello"'), "hello");
  });

  it("removes matching single quotes", () => {
    assert.equal(stripOuterQuotes("'hello'"), "hello");
  });

  it("leaves unquoted strings unchanged", () => {
    assert.equal(stripOuterQuotes("hello"), "hello");
  });

  it("leaves mismatched quotes unchanged", () => {
    assert.equal(stripOuterQuotes("\"hello'"), "\"hello'");
  });
});
