import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../transpiler";

test("E_VALIDATE: run async is rejected in rules", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-async-rule-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow helper() {",
        '  log "hi"',
        "}",
        "rule check() {",
        "  run async helper",
        "}",
        "workflow default() {",
        "  ensure check",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /run async is not allowed in rules/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: run async is accepted in workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-async-wf-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow helper() {",
        '  log "hi"',
        "}",
        "workflow default() {",
        "  run async helper",
        "}",
        "",
      ].join("\n"),
    );
    // Should not throw
    build(join(root, "m.jh"), join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
