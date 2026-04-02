import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

function withTempDir(prefix: string, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- prompt a script → E_VALIDATE ---

test("E_VALIDATE: prompt with script identifier body", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        "  prompt save",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts are not promptable/,
    );
  });
});

test("E_VALIDATE: const = prompt with script identifier body", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        "  const x = prompt save",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts are not promptable/,
    );
  });
});

// --- run a string const → E_VALIDATE ---

test("E_VALIDATE: run a string const in workflow", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const greeting = "hello"',
        "workflow default() {",
        "  run greeting()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /strings are not executable/,
    );
  });
});

test("E_VALIDATE: run a workflow-level const in workflow", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const msg = "hello"',
        "  run msg()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /strings are not executable/,
    );
  });
});

test("E_VALIDATE: const = run a string const in workflow", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const greeting = "hello"',
        "workflow default() {",
        "  const x = run greeting()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /strings are not executable/,
    );
  });
});

test("E_VALIDATE: run a string const in rule", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const greeting = "hello"',
        "rule check() {",
        "  run greeting()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /strings are not executable/,
    );
  });
});

// --- const x = scriptName → E_VALIDATE ---

test("E_VALIDATE: const assignment from script name in workflow", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        "  const x = save",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts are not values/,
    );
  });
});

test("E_VALIDATE: const assignment from script name in rule", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "rule check() {",
        "  const x = save",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts are not values/,
    );
  });
});

// --- ${scriptName} interpolation → E_VALIDATE ---

test("E_VALIDATE: script interpolation in log", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        '  log "result: ${save}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts cannot be interpolated/,
    );
  });
});

test("E_VALIDATE: script interpolation in prompt string", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        '  prompt "do ${save}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts cannot be interpolated/,
    );
  });
});

test("E_VALIDATE: script interpolation in rule log", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "rule check() {",
        '  log "result: ${save}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /scripts cannot be interpolated/,
    );
  });
});

// --- valid usage works unchanged ---

test("valid: prompt with string const works", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const greeting = "hello"',
        "workflow default() {",
        "  prompt greeting",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => buildScripts(join(root, "m.jh"), join(root, "out")));
  });
});

test("valid: run with script works", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        "  run save()",
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => buildScripts(join(root, "m.jh"), join(root, "out")));
  });
});

test("valid: prompt with string literal works", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  prompt "hello world"',
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => buildScripts(join(root, "m.jh"), join(root, "out")));
  });
});

test("valid: const with string value works", () => {
  withTempDir("jaiph-type-cross-", (root) => {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script save = `echo ok`",
        "workflow default() {",
        '  const x = "hello"',
        "}",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => buildScripts(join(root, "m.jh"), join(root, "out")));
  });
});
