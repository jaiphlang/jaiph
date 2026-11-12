import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { parseTestBlock } from "./tests";

// One rule for single-line strings: `\"` is the only escape; every other
// backslash stays as written. `\n`, `\t`, `\\` used to be decoded in config,
// match patterns, and the test DSL — they are E_PARSE for one release.

const matchSource = (pattern: string): string =>
  `export def main(k) {\n  const m = match k {\n    "${pattern}" => "hit"\n    _ => "miss"\n  }\n}\n`;

test("match pattern: \\\" decodes, other backslashes stay verbatim", () => {
  const mod = parsejaiph(matchSource('a\\d \\"q\\"'), "t.jh");
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "const");
  const value = step.type === "const" ? step.value : undefined;
  assert.equal(value?.kind, "match");
  const pattern = value?.kind === "match" ? value.match.arms[0].pattern : undefined;
  assert.deepEqual(pattern, { kind: "string_literal", value: 'a\\d "q"' });
});

for (const esc of ["\\n", "\\t", "\\\\"]) {
  test(`match pattern: removed escape ${esc} is E_PARSE`, () => {
    assert.throws(
      () => parsejaiph(matchSource(`a${esc}b`), "t.jh"),
      (err: Error) => err.message.includes(`match pattern strings no longer decode ${esc}`),
    );
  });
}

const testBlock = (...body: string[]): string[] => ['test "t" {', ...body.map((l) => `  ${l}`), "}"];

test("test DSL: strings keep backslashes verbatim; \\\" decodes", () => {
  const { testBlock: tb } = parseTestBlock(
    "t.test.jh",
    testBlock(
      'const c = "re \\d \\"q\\""',
      'mock prompt "p \\d"',
      'expect_contain out "x \\d"',
      'expect_equal out "y \\"z\\""',
    ),
    0,
  );
  assert.deepEqual(
    tb.steps.map((s) =>
      s.type === "test_const" ? s.value
      : s.type === "test_mock_prompt" ? s.response
      : s.type === "test_expect_contain" ? s.substring
      : s.type === "test_expect_equal" ? s.expected
      : null,
    ),
    ['re \\d "q"', "p \\d", "x \\d", 'y "z"'],
  );
});

for (const line of ['const c = "a\\nb"', 'mock prompt "a\\tb"', 'expect_equal out "a\\\\b"', 'run(\"a\\nb\")']) {
  test(`test DSL: removed escape in ${line} is E_PARSE`, () => {
    assert.throws(
      () => parseTestBlock("t.test.jh", testBlock(line), 0),
      (err: Error) => err.message.includes("test strings no longer decode"),
    );
  });
}

test('test DSL: const = """…""" holds multi-line text verbatim', () => {
  const { testBlock: tb } = parseTestBlock(
    "t.test.jh",
    testBlock('const expected = """', '  line one "q"', "  two \\d", '"""', "expect_equal out expected"),
    0,
  );
  const c = tb.steps[0];
  assert.equal(c.type, "test_const");
  assert.equal(c.type === "test_const" ? c.value : "", 'line one "q"\ntwo \\d');
  assert.equal(tb.steps[1].type, "test_expect_equal");
});
