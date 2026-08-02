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

test("validateJaiphStringContent rejects a malformed inline run reference", () => {
  assert.throws(
    () => validateJaiphStringContent("${run 123bad()}", FILE, 1, 1, "prompt"),
    /invalid inline run reference/,
  );
});

test("extractInlineCaptures pulls run and ensure refs", () => {
  const result = extractInlineCaptures("prefix ${run greet(world)} mid ${ensure check()} suffix");
  assert.deepEqual(
    result.map((c) => ({ kind: c.kind, ref: c.ref })),
    [
      { kind: "run", ref: "greet" },
      { kind: "ensure", ref: "check" },
    ],
  );
});

test("extractInlineCaptures returns empty for plain interpolation", () => {
  assert.deepEqual(extractInlineCaptures("hello ${name} world"), []);
});
