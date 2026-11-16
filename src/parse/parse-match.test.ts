import test from "node:test";
import assert from "node:assert/strict";
import { parseMatchArms } from "./match";
import { parsejaiph } from "./parse-module";
import { parseTestBlock } from "./tests";
import type { MatchArmBody, MatchArmDef } from "../types";
import { BodyCursor } from "./body-cursor";

/** The cursor over `lines` and the position of 0-based line `idx`. */
function src(lines: string[], idx: number, filePath = "test.jh"): [BodyCursor, number] {
  return [BodyCursor.of(filePath, lines.join("\n")), lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0)];
}

/** Strip the `loc` from a `call` arm's callee so bodies compare by shape, not position. */
function normalizeArmBody(body: MatchArmBody): unknown {
  if (body.kind !== "call") return body;
  const callee = { value: body.callee.value };
  return body.args ? { kind: "call", callee, args: body.args } : { kind: "call", callee };
}

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
  const { arms, next } = parseMatchArms(...src(lines, 1), 1);
  assert.equal(arms.length, 2);
  assert.deepEqual(arms[0].pattern, { kind: "string_literal", value: "ok" });
  // Body stored as a triple-quoted literal (escaped quoted string with newlines).
  const body0 = arms[0].body;
  assert.equal(body0.kind, "literal");
  if (body0.kind !== "literal") return;
  assert.equal(body0.tripleQuoted, true);
  assert.ok(body0.raw.startsWith('"'));
  assert.ok(body0.raw.endsWith('"'));
  assert.ok(body0.raw.includes("\n"), "body should contain newline");
  assert.deepEqual(arms[1].pattern, { kind: "wildcard" });
  assert.deepEqual(arms[1].body, { kind: "literal", raw: '"default"' });
  assert.equal(next, src(lines, 7)[1]);
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
    () => parseMatchArms(...src(lines, 1), 1),
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
    () => parseMatchArms(...src(lines, 1), 1),
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
  const { arms } = parseMatchArms(...src(lines, 1), 1);
  assert.equal(arms.length, 2);
  assert.deepEqual(arms[0].body, { kind: "literal", raw: '"result"' });
});

test("parseMatchArms: parses bare expression arm body", () => {
  const lines = [
    '{',
    '  "a" => fail "oops"',
    '  _ => "default"',
    '}',
  ];
  const { arms } = parseMatchArms(...src(lines, 1), 1);
  assert.deepEqual(arms[0].body, { kind: "fail", message: '"oops"' });
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
    () => parseMatchArms(...src(lines, 1), 1),
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
    () => parseMatchArms(...src(lines, 1), 1),
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
    () => parseMatchArms(...src(lines, 1), 1),
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
  const { arms } = parseMatchArms(...src(lines, 1), 1);
  assert.deepEqual(arms[0].pattern, {
    kind: "alternation",
    patterns: [
      { kind: "string_literal", value: "" },
      { kind: "string_literal", value: "check" },
    ],
  });
  assert.deepEqual(arms[0].body, { kind: "literal", raw: '"verify"' });
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
  const { arms } = parseMatchArms(...src(lines, 1), 1);
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
  const { arms } = parseMatchArms(...src(lines, 1), 1);
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
    () => parseMatchArms(...src(lines, 1), 1),
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
    () => parseMatchArms(...src(lines, 1), 1),
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
    () => parseMatchArms(...src(lines, 1), 1),
    /trailing \| in match alternation/,
  );
});

// === Arm-body grammar (match expressions and mock prompt blocks) ===

/** Every match arm list found anywhere in a parsed module, in source order. */
function collectArms(node: unknown, out: MatchArmDef[][] = []): MatchArmDef[][] {
  if (Array.isArray(node)) {
    for (const item of node) collectArms(item, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.arms) && "subject" in obj) out.push(obj.arms as MatchArmDef[]);
    for (const value of Object.values(obj)) collectArms(value, out);
  }
  return out;
}

const ARM_BODY_FORMS: Array<{ name: string; lines: string[]; body: unknown }> = [
  { name: "double-quoted string", lines: ['"x" => "hit"'], body: { kind: "literal", raw: '"hit"' } },
  { name: "string with an apostrophe", lines: [`"x" => "it's fine"`], body: { kind: "literal", raw: `"it's fine"` } },
  { name: '""" block', lines: ['"x" => """', "  line one", '  """'], body: { kind: "literal", raw: '"      line one"', tripleQuoted: true } },
  { name: "identifier", lines: ['"x" => value'], body: { kind: "var", name: "value" } },
  { name: "dotted field", lines: ['"x" => result.field'], body: { kind: "literal", raw: "result.field" } },
  { name: "${…} reference", lines: ['"x" => ${value}'], body: { kind: "literal", raw: "${value}" } },
  { name: "managed call", lines: ['"x" => ref(a, "b, c)")'], body: { kind: "call", callee: { value: "ref" }, args: [{ kind: "var", name: "a" }, { kind: "literal", raw: '"b, c)"' }] } },
  { name: "managed call with alias", lines: ['"x" => alias.ref(a)'], body: { kind: "call", callee: { value: "alias.ref" }, args: [{ kind: "var", name: "a" }] } },
  { name: "managed call without args", lines: ['"x" => ref()'], body: { kind: "call", callee: { value: "ref" } } },
  { name: "fail", lines: ['"x" => fail "reason"'], body: { kind: "fail", message: '"reason"' } },
];

for (const form of ARM_BODY_FORMS) {
  test(`arm-body grammar: ${form.name} parses in a match expression`, () => {
    const source = [
      "export def main(value, result) {",
      "  const x = match value {",
      ...form.lines.map((l) => `    ${l}`),
      '    _ => "default"',
      "  }",
      "}",
      "",
    ].join("\n");
    const [arms] = collectArms(parsejaiph(source, "/tmp/arm.jh"));
    assert.ok(arms, "match expression not found");
    assert.equal(arms.length, 2);
    assert.deepEqual(normalizeArmBody(arms[0].body), form.body);
  });

  test(`arm-body grammar: ${form.name} parses in a mock prompt block`, () => {
    const lines = ['test "t" {', "  mock prompt {", ...form.lines.map((l) => `    ${l}`), '    _ => "default"', "  }", "}"];
    const { testBlock } = parseTestBlock(...src(lines, 0, "arm.test.jh"));
    const step = testBlock.steps[0];
    assert.equal(step.type, "test_mock_prompt_block");
    if (step.type !== "test_mock_prompt_block") return;
    assert.equal(step.arms.length, 2);
    assert.deepEqual(normalizeArmBody(step.arms[0].body), form.body);
  });
}

test("arm-body grammar: compact match accepts every single-line form", () => {
  const source = [
    "export def main(value, result) {",
    '  const x = match value { "a" => "hit", "b" => value, "c" => result.field, "d" => ${value}, "e" => ref(a), "f" => fail "no", _ => "it\'s" }',
    "}",
    "",
  ].join("\n");
  const [arms] = collectArms(parsejaiph(source, "/tmp/arm.jh"));
  assert.deepEqual(
    arms.map((a) => normalizeArmBody(a.body)),
    [
      { kind: "literal", raw: '"hit"' },
      { kind: "var", name: "value" },
      { kind: "literal", raw: "result.field" },
      { kind: "literal", raw: "${value}" },
      { kind: "call", callee: { value: "ref" }, args: [{ kind: "var", name: "a" }] },
      { kind: "fail", message: '"no"' },
      { kind: "literal", raw: `"it's"` },
    ],
  );
});

const REJECTED_BODIES: Array<{ body: string; message: RegExp }> = [
  { body: 'return "yes"', message: /match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>/ },
  { body: "'echo yes'()", message: /inline scripts are not allowed in match arm bodies; use a named script with "script_name\(…\)" instead/ },
  { body: "python3'print(1)'()", message: /inline scripts are not allowed in match arm bodies/ },
  { body: "'''", message: /inline scripts are not allowed in match arm bodies/ },
  { body: "`echo hi`()", message: /inline scripts are not allowed in match arm bodies/ },
  { body: "some bare words", message: /unknown match arm verb "some"; allowed: fail "\.\.\.", ref\(\.\.\.\)\.$/ },
  { body: 'error "missing"', message: /unknown match arm verb "error"; allowed: fail "\.\.\.", ref\(\.\.\.\)\. did you mean "fail"\?$/ },
  { body: "$x", message: /invalid match arm body: \$x; expected a string, """ block, identifier, \$\{…\}, ref\(\.\.\.\), or fail "\.\.\."$/ },
  { body: "1 + 2", message: /invalid match arm body: 1 \+ 2;/ },
];

for (const { body, message } of REJECTED_BODIES) {
  test(`arm-body grammar: ${body} is E_PARSE at the body column (match and mock prompt)`, () => {
    const armLine = `    "x" => ${body}`;
    const col = armLine.indexOf(body) + 1;
    const source = ["export def main(value) {", "  const x = match value {", armLine, '    _ => "d"', "  }", "}", ""].join("\n");
    assert.throws(() => parsejaiph(source, "/tmp/arm.jh"), (err: Error) => {
      assert.match(err.message, new RegExp(`:3:${col} E_PARSE `));
      assert.match(err.message, message);
      return true;
    });
    const lines = ['test "t" {', "  mock prompt {", armLine, '    _ => "d"', "  }", "}"];
    assert.throws(() => parseTestBlock(...src(lines, 0, "arm.test.jh")), (err: Error) => {
      assert.match(err.message, new RegExp(`:3:${col} E_PARSE `));
      assert.match(err.message, message);
      return true;
    });
  });
}
