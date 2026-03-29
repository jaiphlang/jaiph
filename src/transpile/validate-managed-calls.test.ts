import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("E_VALIDATE: inline shell step is forbidden in workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-sub-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'x'",
        "}",
        "workflow default() {",
        '  x="$(f)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: direct inline shell step is forbidden in workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-direct-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'x'",
        "}",
        "workflow default() {",
        "  f",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts extracts script for run with capture workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-run-fn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'ok'",
        "}",
        "workflow default() {",
        "  x = run f",
        '  return "${x}"',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
    const names = readdirSync(join(out, "scripts"));
    assert.ok(names.includes("f"));
    assert.match(readFileSync(join(out, "scripts", "f"), "utf8"), /printf/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: inline shell line with workflow ref is forbidden", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-wf-plus-sub-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script w_impl() {",
        "  echo x",
        "}",
        "workflow w() {",
        "  run w_impl",
        "}",
        "workflow default() {",
        "  w $(true)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: send RHS cannot invoke Jaiph workflow via shell", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-send-wf-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "channel c",
        "script w_impl() {",
        "  echo x",
        "}",
        "workflow w() {",
        "  run w_impl",
        "}",
        "workflow default() {",
        "  c <- w",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(join(root, "m.jh"), join(root, "out")), /workflow "w"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
