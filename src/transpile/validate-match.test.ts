import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("E_VALIDATE: return as leading token of match arm body is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-ret-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => return "yes"',
        '    _ => "no"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /match arm body must not start with "return"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: inline script in match arm body is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-inline-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        "    \"ok\" => `echo yes`()",
        '    _ => "no"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline scripts are not allowed in match arm bodies/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("return match at workflow level remains valid", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-outer-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => "yes"',
        '    _ => "no"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match arm with fail body is accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-fail-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => fail "bad"',
        '    _ => "default"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match arm with run ref body is accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-run-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script helper = `echo ok`",
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => run helper()',
        '    _ => "default"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match arm with unknown verb (e.g. error) is rejected with hint", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-unknown-verb-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "" => error "missing"',
        "    _ => true",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      { message: /unknown match arm verb "error".*did you mean "fail"/ },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match arm with bare function-call form (error(\"...\")) is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-bare-call-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "" => error("missing")',
        "    _ => true",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      { message: /unknown match arm verb "error"/ },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match arm with single bare token (true) is accepted as string value", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-bare-token-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => true',
        "    _ => false",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("triple-quoted arm body parses and validates", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-match-tq-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = "ok"',
        "  return match x {",
        '    "ok" => """',
        "line one",
        "line two",
        '    """',
        '    _ => "default"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
