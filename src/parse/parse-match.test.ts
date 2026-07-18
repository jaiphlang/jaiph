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

// === parseMatchArms: comma rejection ===

test("parseMatchArms: rejects trailing comma after bare arm body", () => {
  const lines = [
    '{',
    '  "" => fail "You didn\'t provide your name :(",',
    '  _ => name_arg',
    '}',
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /commas are not allowed in match arms; use one arm per line/,
  );
});

test("parseMatchArms: rejects trailing comma after quoted arm body", () => {
  const lines = [
    '{',
    '  "a" => "result",',
    '  _ => "default"',
    '}',
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /commas are not allowed in match arms; use one arm per line/,
  );
});

test("parseMatchArms: rejects comma-separated arms on one line", () => {
  const lines = [
    '{',
    '  "a" => "x", _ => "y"',
    '}',
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /commas are not allowed in match arms; use one arm per line/,
  );
});

// === parseMatchArms: pattern alternation ("a" | "b" => ...) ===

test("parseMatchArms: parses string-literal alternation pattern", () => {
  const lines = [
    "{",
    '  "" | "check" => "verify"',
    '  _ => "unknown"',
    "}",
  ];
  const { arms } = parseMatchArms("test.jh", lines, 1, 1);
  assert.deepEqual(arms[0].pattern, {
    kind: "alternation",
    patterns: [
      { kind: "string_literal", value: "" },
      { kind: "string_literal", value: "check" },
    ],
  });
  assert.equal(arms[0].body, '"verify"');
  assert.deepEqual(arms[1].pattern, { kind: "wildcard" });
});

test("parseMatchArms: parses three-way and regex alternation", () => {
  const lines = [
    "{",
    '  "a" | "b" | "c" => "letters"',
    '  /^x/ | /^y/ => "prefixes"',
    '  _ => "other"',
    "}",
  ];
  const { arms } = parseMatchArms("test.jh", lines, 1, 1);
  assert.equal(arms[0].pattern.kind, "alternation");
  if (arms[0].pattern.kind === "alternation") {
    assert.equal(arms[0].pattern.patterns.length, 3);
  }
  assert.deepEqual(arms[1].pattern, {
    kind: "alternation",
    patterns: [
      { kind: "regex", source: "^x" },
      { kind: "regex", source: "^y" },
    ],
  });
});

test("parseMatchArms: allows mixed string and regex alternation", () => {
  const lines = [
    "{",
    '  "exact" | /^pre/ => "hit"',
    '  _ => "miss"',
    "}",
  ];
  const { arms } = parseMatchArms("test.jh", lines, 1, 1);
  assert.deepEqual(arms[0].pattern, {
    kind: "alternation",
    patterns: [
      { kind: "string_literal", value: "exact" },
      { kind: "regex", source: "^pre" },
    ],
  });
});

test("parseMatchArms: rejects wildcard as trailing alternand (\"a\" | _)", () => {
  const lines = [
    "{",
    '  "a" | _ => "x"',
    '  _ => "y"',
    "}",
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /wildcard _ cannot participate in match alternation/,
  );
});

test("parseMatchArms: rejects wildcard as leading alternand (_ | \"x\")", () => {
  const lines = [
    "{",
    '  _ | "x" => "hit"',
    '  _ => "y"',
    "}",
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /wildcard _ cannot participate in match alternation/,
  );
});

test("parseMatchArms: rejects trailing pipe before =>", () => {
  const lines = [
    "{",
    '  "a" | => "x"',
    '  _ => "y"',
    "}",
  ];
  assert.throws(
    () => parseMatchArms("test.jh", lines, 1, 1),
    /trailing \| in match alternation/,
  );
});
