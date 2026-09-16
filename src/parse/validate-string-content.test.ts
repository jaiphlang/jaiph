import test from "node:test";
import assert from "node:assert/strict";
import {
  validateJaiphStringContent,
  extractInlineCaptures,
} from "./validate-string-content";

const FILE = "m.jh";

test("validateJaiphStringContent accepts canonical ${name} interpolation", () => {
  assert.doesNotThrow(() => validateJaiphStringContent("hello ${name}", FILE, 1, 1, "log"));
});

test("validateJaiphStringContent rejects bare $name", () => {
  assert.throws(
    () => validateJaiphStringContent("hi $name", FILE, 1, 1, "log"),
    /bare interpolation/,
  );
});

test("validateJaiphStringContent rejects shell fallback ${var:-default}", () => {
  assert.throws(
    () => validateJaiphStringContent("${x:-y}", FILE, 1, 1, "log"),
    /shell fallback syntax/,
  );
});

test("validateJaiphStringContent rejects command substitution $( ... )", () => {
  assert.throws(
    () => validateJaiphStringContent("out $(whoami)", FILE, 1, 1, "log"),
    /command substitution/,
  );
});

test("validateJaiphStringContent rejects numeric ${N}", () => {
  assert.throws(
    () => validateJaiphStringContent("arg ${1}", FILE, 1, 1, "log"),
    /numeric interpolation/,
  );
});

test("validateJaiphStringContent rejects a malformed inline call reference", () => {
  assert.throws(
    () => validateJaiphStringContent("${a.b.c()}", FILE, 1, 1, "prompt"),
    /invalid inline call reference/,
  );
});

test("extractInlineCaptures pulls call refs", () => {
  const result = extractInlineCaptures("prefix ${greet(world)} mid ${check()} suffix");
  assert.deepEqual(
    result.map((c) => ({ ref: c.ref })),
    [
      { ref: "greet" },
      { ref: "check" },
    ],
  );
});

test("extractInlineCaptures returns empty for plain interpolation", () => {
  assert.deepEqual(extractInlineCaptures("hello ${name} world"), []);
});
