import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/transpiler";

test("E_VALIDATE: command substitution cannot call Jaiph function", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-sub-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'x'",
        "}",
        "workflow default {",
        '  x="$(f)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(join(root, "m.jh"), join(root, "out")), /command substitution cannot invoke script "f"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: workflow shell cannot call function directly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-direct-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'x'",
        "}",
        "workflow default {",
        "  f",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(join(root, "m.jh"), join(root, "out")), /direct script call "f"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build accepts run with local function and capture", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-run-fn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f() {",
        "  printf '%s' 'ok'",
        "}",
        "workflow default {",
        "  x = run f",
        "  echo \"$x\"",
        "}",
        "",
      ].join("\n"),
    );
    const r = build(join(root, "m.jh"), out);
    assert.equal(r.length, 1);
    assert.match(r[0].bash, /JAIPH_RETURN_VALUE_FILE/);
    assert.match(r[0].bash, /::f/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: workflow shell line cannot lead with Jaiph ref even when line has $(...)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-wf-plus-sub-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow w {",
        "  echo x",
        "}",
        "workflow default {",
        "  w $(true)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(join(root, "m.jh"), join(root, "out")), /workflow "w"/);
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
        "workflow w {",
        "  echo x",
        "}",
        "workflow default {",
        "  c <- w",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(join(root, "m.jh"), join(root, "out")), /workflow "w"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
