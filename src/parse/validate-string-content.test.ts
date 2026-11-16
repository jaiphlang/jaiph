import test from "node:test";
import assert from "node:assert/strict";
import {
  validateJaiphStringContent,
  extractInlineCaptures,
  scanInlineCaptures,
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

test("scanInlineCaptures reports span and parsed call for each capture", () => {
  const content = "a ${greet(world)} b ${check()} c";
  const matches = scanInlineCaptures(content);
  assert.equal(matches.length, 2);
  // First capture: span covers the whole `${greet(world)}`, ref + typed arg parsed.
  assert.equal(content.slice(matches[0].index, matches[0].index + matches[0].length), "${greet(world)}");
  assert.equal(matches[0].ref, "greet");
  assert.deepEqual(matches[0].args, [{ kind: "var", name: "world" }]);
  assert.equal(matches[1].ref, "check");
  assert.equal(matches[1].args, undefined);
});

test("scanInlineCaptures marks an unparseable call ref null", () => {
  // Three-dot ref is not a valid call head; the runtime leaves it as text.
  const matches = scanInlineCaptures("x ${a.b.c()} y");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, null);
  assert.equal(matches[0].body, "a.b.c()");
});
