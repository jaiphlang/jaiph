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
        "workflow ok() {",
        "  run ok_impl()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow check_wf() {",
        "  run check()",
        "}",
        "script fix_impl = `touch .marker`",
        "workflow fix() {",
        "  run fix_impl()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow failing() {",
        "  run always_fail()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
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
        "workflow attempt_wf() {",
        "  run count_impl()",
        "}",
        "script bump_impl = ```",
        'count=$(cat .counter)',
        'echo $(( count + 1 )) > .counter',
        "```",
        "workflow bump() {",
        "  run bump_impl()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow greet() {",
        "  run echo_val()",
        '  return "hello"',
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow producer() {",
        '  return "produced"',
        "}",
        "workflow consumer(val) {",
        '  log "${val}"',
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow make_a() {",
        '  return "A"',
        "}",
        "workflow make_b() {",
        '  return "B"',
        "}",
        "workflow combine(a, b) {",
        '  log "${a}-${b}"',
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow bg() {",
        "  run noop()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow first() {",
        '  return "1"',
        "}",
        "workflow second() {",
        '  return "2"',
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow check_wf() {",
        "  run check()",
        "}",
        "script fix_impl = `touch .marker`",
        "workflow fix() {",
        "  run fix_impl()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
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
        "workflow failing() {",
        "  run always_fail()",
        "}",
        "workflow default() {",
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
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });
    assert.notEqual(r.status, 0, "should fail after retry limit exhausted");
    const combined = r.stdout + r.stderr;
    assert.match(combined, /FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
