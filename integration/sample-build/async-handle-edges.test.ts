import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import "./helpers";

function runJh(
  root: string,
  lines: string[],
  opts: { timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
  writeFileSync(join(root, "main.jh"), `${lines.join("\n")}\n`);
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const r = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env },
    timeout: opts.timeoutMs,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
}

test("handle: catch on run async treats a recovered branch as a successful join", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-catch-"));
  try {
    const r = runJh(root, [
      "script always_fail = `exit 1`",
      "def failing() {",
      "  run always_fail()",
      "}",
      "export def main() {",
      "  run async failing() catch (e) {",
      '    log "caught"',
      "  }",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, /caught/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: catch return on run async becomes the parent def return", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-catch-ret-"));
  try {
    const r = runJh(root, [
      "script always_fail = `exit 1`",
      "def failing() {",
      "  run always_fail()",
      "}",
      "export def main() {",
      "  run async failing() catch (e) {",
      '    return "recovered"',
      "  }",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /recovered/, "catch return must surface as the parent return value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: failed ${h} read empties the binding so a later catch sees empty", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-empty-"));
  try {
    const r = runJh(root, [
      "script always_fail = `exit 1`",
      "def boom() {",
      "  run always_fail()",
      "}",
      "def read_it(v) {",
      '  log "${v}"',
      "}",
      "export def main() {",
      "  const h = run async boom()",
      "  run read_it(h) catch (e) {",
      '    log "after:${h}:"',
      '    return "ok"',
      "  }",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /after::/, "failed resolve must empty h so ${h} is blank");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: for_lines iterates the token as one line, not the resolved lines", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-for-"));
  try {
    const r = runJh(root, [
      "script three = `printf 'a\\nb\\nc\\n'`",
      "def producer() {",
      "  return run three()",
      "}",
      "script bump = `echo x >> .n`",
      "script count = `wc -l < .n | tr -d ' '`",
      "export def main() {",
      "  const h = run async producer()",
      "  for line in h {",
      "    run bump()",
      "  }",
      "  const n = run count()",
      "  return n",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\b1\b/, "unresolved handle is one token line, not three result lines");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: early return skips implicit join of unread async work", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-early-"));
  try {
    const r = runJh(
      root,
      [
        "script slow = `sleep 30; echo done`",
        "def bg() {",
        "  run slow()",
        "}",
        "export def main() {",
        "  run async bg()",
        '  return "early"',
        "}",
      ],
      { timeoutMs: 8000 },
    );
    assert.equal(r.status, 0, `join must not wait for the 30s branch: ${r.stderr}`);
    assert.equal(r.signal, null, "spawn must not hit the 8s timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: if-body async work joins before the step after the if", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-if-join-"));
  try {
    const r = runJh(root, [
      "script mark = `sleep 1; echo done > .marker`",
      "script check_mark = `test -f .marker && echo yes || echo no`",
      "def bg() {",
      "  run mark()",
      "}",
      "export def main() {",
      '  const flag = "y"',
      "  if flag == \"y\" {",
      "    run async bg()",
      "  }",
      "  const seen = run check_mark()",
      "  return seen",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\byes\b/, "if-body join must finish before the next step");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handle: send from an async branch is delivered after the implicit join", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-send-"));
  try {
    const r = runJh(root, [
      "channel findings -> handler",
      "def handler(msg) {",
      '  log "got:${msg}"',
      "}",
      "def producer() {",
      '  send "hello" -> findings',
      "}",
      "export def main() {",
      "  run async producer()",
      "}",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /got:hello/, "inbox drain must run after the async join");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
