import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./fs-lock";

test("acquireLock: creates lock directory and pid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-lock-"));
  const lockdir = join(dir, "test.lock");
  try {
    const result = acquireLock(lockdir);
    assert.equal(result, true);
    assert.ok(existsSync(lockdir));
    assert.ok(existsSync(join(lockdir, "pid")));
    const pid = readFileSync(join(lockdir, "pid"), "utf8").trim();
    assert.equal(pid, String(process.pid));
  } finally {
    releaseLock(lockdir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock: removes lock directory and pid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-lock-"));
  const lockdir = join(dir, "test.lock");
  try {
    acquireLock(lockdir);
    assert.ok(existsSync(lockdir));
    releaseLock(lockdir);
    assert.ok(!existsSync(lockdir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: succeeds after releaseLock", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-lock-"));
  const lockdir = join(dir, "test.lock");
  try {
    assert.equal(acquireLock(lockdir), true);
    releaseLock(lockdir);
    assert.equal(acquireLock(lockdir), true);
  } finally {
    releaseLock(lockdir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: cleans up stale lock from dead process", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-lock-"));
  const lockdir = join(dir, "test.lock");
  try {
    // Simulate a stale lock from a non-existent PID
    mkdirSync(lockdir);
    writeFileSync(join(lockdir, "pid"), "999999999\n");
    const result = acquireLock(lockdir);
    assert.equal(result, true);
    const pid = readFileSync(join(lockdir, "pid"), "utf8").trim();
    assert.equal(pid, String(process.pid));
  } finally {
    releaseLock(lockdir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: times out when lock held by live process", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-lock-"));
  const lockdir = join(dir, "test.lock");
  const origTimeout = process.env.JAIPH_LOCK_TIMEOUT_SECONDS;
  const origSleep = process.env.JAIPH_LOCK_SLEEP_SECONDS;
  try {
    // Create lock held by current process (which is alive)
    mkdirSync(lockdir);
    writeFileSync(join(lockdir, "pid"), `${process.pid}\n`);
    // Set very short timeout
    process.env.JAIPH_LOCK_TIMEOUT_SECONDS = "0";
    process.env.JAIPH_LOCK_SLEEP_SECONDS = "0.001";
    const result = acquireLock(lockdir);
    assert.equal(result, false);
  } finally {
    if (origTimeout === undefined) delete process.env.JAIPH_LOCK_TIMEOUT_SECONDS;
    else process.env.JAIPH_LOCK_TIMEOUT_SECONDS = origTimeout;
    if (origSleep === undefined) delete process.env.JAIPH_LOCK_SLEEP_SECONDS;
    else process.env.JAIPH_LOCK_SLEEP_SECONDS = origSleep;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock: no-op on nonexistent lock", () => {
  releaseLock("/tmp/jaiph-nonexistent-lock-dir-12345");
});
