import test from "node:test";
import assert from "node:assert/strict";
import { parseMatchArms } from "./match";

// === parseMatchArms: triple-quoted arm bodies ===

test("parseMatchArms: parses triple-quoted arm body", () => {
  const lines = [
    'match x {',
    '  "ok" => """',
    "line one",
    "line two",
    '  """',
    '  _ => "default"',
    "}",
  ];
  const { arms, nextIndex } = parseMatchArms("test.jh", lines, 1, 1);
  assert.equal(arms.length, 2);
  assert.deepEqual(arms[0].pattern, { kind: "string_literal", value: "ok" });
  // Body stored as escaped quoted string with actual newlines
  assert.ok(arms[0].body.startsWith('"'));
  assert.ok(arms[0].body.endsWith('"'));
  assert.ok(arms[0].body.includes("\n"), "body should contain newline");
  assert.deepEqual(arms[1].pattern, { kind: "wildcard" });
  assert.equal(arms[1].body, '"default"');
  assert.equal(nextIndex, 7);
});

test("parseMatchArms: rejects content on opening triple-quote line", () => {
  const lines = [
    'match x {',
    '  "ok" => """stuff',
    '  """',
    '  _ => "default"',
    "}",
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /opening """ in match arm must not have content on the same line/,
  );
});

test("parseMatchArms: rejects unterminated triple-quoted arm", () => {
  const lines = [
    'match x {',
    '  "ok" => """',
    "line one",
    "}",
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /unterminated triple-quoted block in match arm/,
  );
});

// === parseMatchArms: single-line arm bodies (existing behavior) ===

test("parseMatchArms: parses string literal arm body", () => {
  const lines = [
    '{',
    '  "a" => "result"',
    '  _ => "default"',
    '}',
  ];
  const { arms } = parseMatchArms("test.jh", lines, 1, 1);
  assert.equal(arms.length, 2);
  assert.equal(arms[0].body, '"result"');
});

test("parseMatchArms: parses bare expression arm body", () => {
  const lines = [
    '{',
    '  "a" => fail "oops"',
    '  _ => "default"',
    '}',
  ];
  const { arms } = parseMatchArms("test.jh", lines, 1, 1);
  assert.equal(arms[0].body, 'fail "oops"');
});
