import test from "node:test";
import assert from "node:assert/strict";
import { interpolate } from "./config";

test("interpolate substitutes ${var} from the vars map", () => {
  assert.equal(interpolate("hello ${name}", new Map([["name", "world"]])), "hello world");
});

test("interpolate falls back to env when var is absent", () => {
  assert.equal(interpolate("home=${HOME}", new Map(), { HOME: "/tmp" }), "home=/tmp");
});

test("interpolate yields empty string for unknown reference", () => {
  assert.equal(interpolate("[${missing}]", new Map()), "[]");
});

test("interpolate resolves ${var.field} from JSON-encoded values", () => {
  const vars = new Map([["user", JSON.stringify({ name: "Adam", age: 30 })]]);
  assert.equal(interpolate("hi ${user.name}, age ${user.age}", vars), "hi Adam, age 30");
});

test("interpolate passes substituted values through quoteValue", () => {
  const vars = new Map([["x", "a b"]]);
  assert.equal(interpolate("${x}", vars, undefined, (s) => `'${s}'`), "'a b'");
});
