import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import "./helpers";

// --- recover loop semantics ---

test("recover: success on first attempt skips recover body", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-pass-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "script ok_impl = `echo ok`",
        "def ok() {",
        "  run ok_impl()",
        "}",
        "export def main() {",
        '  run ok() recover(err) {',
        '    log "should not run"',
        '  }',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recover: one repair loop before success", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-repair-"));
  try {
    // Script that fails unless a marker file exists (created by the recover body)
    writeFileSync(
      join(root, "main.jh"),
      [
        "script check = `test -f .marker`",
        "def check_wf() {",
        "  run check()",
        "}",
        "script fix_impl = `touch .marker`",
        "def fix() {",
        "  run fix_impl()",
        "}",
        "export def main() {",
        "  run check_wf() recover(err) {",
        "    run fix()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
    assert.ok(existsSync(join(root, ".marker")), "repair body should have created marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recover: retry limit exhaustion fails the workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-exhaust-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "config {",
        "  run.recover_limit = 2",
        "}",
        "",
        "script always_fail = `exit 1`",
        "def failing() {",
        "  run always_fail()",
        "}",
        "export def main() {",
        '  run failing() recover(err) {',
        '    log "repair attempt"',
        '  }',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recover: def-level run.recover_limit overrides module-level", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-workflow-cfg-"));
  try {
    writeFileSync(join(root, ".counter"), "0");
    writeFileSync(
      join(root, "main.jh"),
      [
        "config {",
        "  run.recover_limit = 50",
        "}",
        "",
        "script bump_and_fail = ```",
        "count=$(cat .counter)",
        "echo $(( count + 1 )) > .counter",
        "exit 1",
        "```",
        "def failing() {",
        "  run bump_and_fail()",
        "}",
        "export def main() {",
        "  config {",
        "    run.recover_limit = 2",
        "  }",
        '  run failing() recover(err) {',
        '    log "repair attempt"',
        '  }',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
    const counter = require("node:fs").readFileSync(join(root, ".counter"), "utf8").trim();
    // limit=2 means 1 initial attempt + 2 retries = 3 invocations of the failing script.
    assert.equal(counter, "3", `expected 3 attempts, got ${counter}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recover: sibling workflow without own config uses module-level run.recover_limit", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-sibling-cfg-"));
  try {
    writeFileSync(join(root, ".counter"), "0");
    writeFileSync(
      join(root, "main.jh"),
      [
        "config {",
        "  run.recover_limit = 2",
        "}",
        "",
        "script bump_and_fail = ```",
        "count=$(cat .counter)",
        "echo $(( count + 1 )) > .counter",
        "exit 1",
        "```",
        "def failing() {",
        "  run bump_and_fail()",
        "}",
        "def other_default() {",
        "  config {",
        "    run.recover_limit = 50",
        "  }",
        '  run failing() recover(err) {',
        '    log "ignored"',
        '  }',
        "}",
        "export def main() {",
        '  run failing() recover(err) {',
        '    log "repair attempt"',
        '  }',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
    const counter = require("node:fs").readFileSync(join(root, ".counter"), "utf8").trim();
    // Module-level limit=2 → 1 initial + 2 retries = 3 attempts in `default` (no own config).
    assert.equal(counter, "3", `expected 3 attempts, got ${counter}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recover: retry limit configurable via config", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-recover-limit-"));
  try {
    // Counter file incremented by recover body; check script reads and compares.
    writeFileSync(join(root, ".counter"), "0");
    writeFileSync(
      join(root, "main.jh"),
      [
        "config {",
        "  run.recover_limit = 3",
        "}",
        "",
        "script count_impl = ```",
        'count=$(cat .counter)',
        'if [ "$count" -ge 3 ]; then exit 0; fi',
        "exit 1",
        "```",
        "def attempt_wf() {",
        "  run count_impl()",
        "}",
        "script bump_impl = ```",
        'count=$(cat .counter)',
        'echo $(( count + 1 )) > .counter',
        "```",
        "def bump() {",
        "  run bump_impl()",
        "}",
        "export def main() {",
        "  run attempt_wf() recover(err) {",
        "    run bump()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Handle<T> async model tests --

test("handle: const capture run async creates handle that resolves on read", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-capture-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        'script echo_val = `echo "hello"`',
        "def greet() {",
        "  run echo_val()",
        '  return "hello"',
        "}",
        "export def main() {",
        "  const h = run async greet()",
        '  log "${h}"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: passing handle as arg to run forces resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-resolve-arg-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def producer() {",
        '  return "produced"',
        "}",
        "def consumer(val) {",
        '  log "${val}"',
        "}",
        "export def main() {",
        "  const h = run async producer()",
        "  run consumer(h)",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: multi-handle join — multiple async handles passed into another call", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-multi-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def make_a() {",
        '  return "A"',
        "}",
        "def make_b() {",
        '  return "B"',
        "}",
        "def combine(a, b) {",
        '  log "${a}-${b}"',
        "}",
        "export def main() {",
        "  const ha = run async make_a()",
        "  const hb = run async make_b()",
        "  run combine(ha, hb)",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: workflow exit joins unresolved handles without error", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-join-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        'script noop = `echo "done"`',
        "def bg() {",
        "  run noop()",
        "}",
        "export def main() {",
        "  const h = run async bg()",
        '  log "continuing"',
        "  # h is never read — implicit join at exit",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: handles stored in separate vars and resolved when read", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-stored-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def first() {",
        '  return "1"',
        "}",
        "def second() {",
        '  return "2"',
        "}",
        "export def main() {",
        "  const h1 = run async first()",
        "  const h2 = run async second()",
        "  # Both stored, not resolved yet",
        '  log "${h1}"',
        '  log "${h2}"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: run async foo() recover — handle resolves to success after repair", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-recover-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "script check = `test -f .marker`",
        "def check_wf() {",
        "  run check()",
        "}",
        "script fix_impl = `touch .marker`",
        "def fix() {",
        "  run fix_impl()",
        "}",
        "export def main() {",
        "  run async check_wf() recover(err) {",
        "    run fix()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
    assert.ok(existsSync(join(root, ".marker")), "repair body should have created marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: run async recover shares retry-limit semantics with non-async recover", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-handle-recover-limit-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "config {",
        "  run.recover_limit = 2",
        "}",
        "",
        "script always_fail = `exit 1`",
        "def failing() {",
        "  run always_fail()",
        "}",
        "export def main() {",
        '  run async failing() recover(err) {',
        '    log "repair attempt"',
        '  }',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
