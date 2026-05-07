import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { consumeNextMockResponse, dispatchMockArms } from "./mock";

describe("consumeNextMockResponse", () => {
  it("returns responses in order, then null when exhausted", () => {
    const json = JSON.stringify(["first", "second", "third"]);
    assert.equal(consumeNextMockResponse(json), "first");
    assert.equal(consumeNextMockResponse(json), "second");
    assert.equal(consumeNextMockResponse(json), "third");
    assert.equal(consumeNextMockResponse(json), null);
  });

  it("re-seeds when JSON changes", () => {
    consumeNextMockResponse(JSON.stringify(["a"]));
    const result = consumeNextMockResponse(JSON.stringify(["b", "c"]));
    assert.equal(result, "b");
  });

  it("returns null on invalid JSON", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = consumeNextMockResponse("not-json");
    process.stderr.write = origWrite;
    assert.equal(result, null);
  });
});

describe("dispatchMockArms", () => {
  it("matches a string-literal arm exactly", () => {
    const result = dispatchMockArms("hello", [
      { kind: "string", pattern: "hello", response: "world" },
      { kind: "wildcard", response: "fallback" },
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.response, "world");
  });

  it("matches a regex arm when pattern matches", () => {
    const result = dispatchMockArms("foo-123", [
      { kind: "regex", pattern: "^foo-\\d+$", response: "matched" },
      { kind: "wildcard", response: "fallback" },
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.response, "matched");
  });

  it("falls through to wildcard when no other arm matches", () => {
    const result = dispatchMockArms("anything", [
      { kind: "string", pattern: "specific", response: "no" },
      { kind: "wildcard", response: "default" },
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.response, "default");
  });

  it("returns status 1 with no match and no wildcard", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = dispatchMockArms("nothing matches", [
      { kind: "string", pattern: "foo", response: "x" },
    ]);
    process.stderr.write = origWrite;
    assert.equal(result.status, 1);
    assert.equal(result.response, "");
  });

  it("first matching arm wins", () => {
    const result = dispatchMockArms("hello", [
      { kind: "regex", pattern: "^h", response: "first" },
      { kind: "regex", pattern: "lo$", response: "second" },
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.response, "first");
  });
});
