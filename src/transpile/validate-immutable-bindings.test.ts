import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("E_VALIDATE: const rebinding a workflow parameter is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "export def main(name_arg) {",
        '  const name_arg = "rebind"',
        '  return "${name_arg}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /cannot rebind immutable name "name_arg".*parameter/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: const rebinding a rule parameter is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-rule-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "def check(x) {",
        '  const x = "rebind"',
        '  return "${x}"',
        "}",
        "export def main() {",
        '  run check("ok")',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /cannot rebind immutable name "x".*parameter/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: duplicate const declarations in the same scope are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-dup-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "export def main() {",
        '  const x = "first"',
        '  const x = "second"',
        '  return "${x}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /cannot rebind immutable name "x".*const/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_PARSE: script name colliding with top-level const is rejected at parse time", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-script-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const greet = "hello"',
        "",
        "script greet = `echo hi`",
        "",
        "export def main() {",
        '  return "${greet}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /duplicate name "greet"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_PARSE: duplicate script declarations are rejected at parse time", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-dup-script-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script greet = `echo hi`",
        "",
        "script greet = `echo hello`",
        "",
        "export def main() {",
        "  run greet()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /duplicate name "greet"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: const rebinding parameter via run is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-ensure-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "def valid(v) {",
        '  return "${v}"',
        "}",
        "export def main(name_arg) {",
        "  const name_arg = run valid(name_arg)",
        '  return "${name_arg}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /cannot rebind immutable name "name_arg".*parameter/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid: distinct param and const names compile successfully", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-immut-ok-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "export def main(input) {",
        '  const result = "processed ${input}"',
        '  return "${result}"',
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
