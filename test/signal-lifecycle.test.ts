import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Linux minimal images often omit procps (`ps` / `pgrep`); use /proc instead. */
function useLinuxProcForPids(): boolean {
  return process.platform === "linux" && existsSync("/proc/self/status");
}

function readPpidFromProcStatus(pid: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^PPid:\s+(\d+)/m.exec(text);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function readProcCmdlineJoined(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("latin1").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function findChildPidsViaProc(parentPid: number): number[] {
  const result: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    if (readPpidFromProcStatus(pid) === parentPid) result.push(pid);
  }
  return result;
}

function findChildPidsMatchingViaProc(parentPid: number, pattern: string): number[] {
  return findChildPidsViaProc(parentPid).filter((pid) =>
    readProcCmdlineJoined(pid).includes(pattern),
  );
}

function anyPidsAliveViaProc(pids: number[]): boolean {
  return pids.some((p) => existsSync(`/proc/${p}`));
}

/** Return PIDs matching pattern whose parent is parentPid (direct children only). */
function findChildPidsMatching(parentPid: number, pattern: string): number[] {
  if (useLinuxProcForPids()) {
    return findChildPidsMatchingViaProc(parentPid, pattern);
  }
  const pgrep = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  const pids = (pgrep.stdout?.trim() || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (pids.length === 0) return [];
  const ps = spawnSync("ps", ["-o", "pid=,ppid=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const lines = (ps.stdout?.trim() || "").split(/\n/).filter(Boolean);
  const result: number[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (!Number.isNaN(pid) && !Number.isNaN(ppid) && ppid === parentPid) result.push(pid);
    }
  }
  return result;
}

/** Return direct child PIDs for parentPid (no command filter). */
function findChildPids(parentPid: number): number[] {
  if (useLinuxProcForPids()) {
    return findChildPidsViaProc(parentPid);
  }
  const ps = spawnSync("ps", ["-o", "pid=,ppid=", "-ax"], { encoding: "utf8" });
  const lines = (ps.stdout?.trim() || "").split(/\n/).filter(Boolean);
  const result: number[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (!Number.isNaN(pid) && !Number.isNaN(ppid) && ppid === parentPid) result.push(pid);
    }
  }
  return result;
}

/** Return true if any of the given PIDs are still running. */
function anyPidsAlive(pids: number[]): boolean {
  if (pids.length === 0) return false;
  if (useLinuxProcForPids()) {
    return anyPidsAliveViaProc(pids);
  }
  const ps = spawnSync("ps", ["-o", "pid=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const seen = new Set(
    (ps.stdout?.trim() || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(Number),
  );
  return pids.some((p) => seen.has(p));
}

/**
 * Acceptance test: jaiph run interruption (SIGINT/SIGTERM path).
 * Locks lifecycle behavior before CLI refactor: non-hanging exit, cleanup, no stale child processes.
 */
async function runInterruptTest(
  root: string,
  cliPath: string,
  signal: "SIGINT" | "SIGTERM",
): Promise<void> {
  const workflowPath = join(root, "long.jh");
  writeFileSync(
    workflowPath,
    ['script sleep_impl = `sleep 120`', "workflow default() {", "  run sleep_impl()", "}"].join("\n"),
  );

  const child = spawn("node", [cliPath, "run", workflowPath], {
    stdio: "pipe",
    cwd: root,
    env: { ...process.env, CI: "true" }, // disable Docker so exit-within-5s assertion is reliable
  });

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, sig) => {
      resolve({ code, signal: sig });
    });
  });

  // Let the workflow start (bash + sleep running)
  await new Promise((r) => setTimeout(r, 600));

  const nodePid = child.pid;
  assert.ok(nodePid != null, "spawned node process must have a pid");
  const ourJaiphRunPids = findChildPidsMatching(nodePid, "jaiph-run");
  const fallbackChildPids = findChildPids(nodePid);
  const trackedPids = ourJaiphRunPids.length > 0 ? ourJaiphRunPids : fallbackChildPids;
  assert.ok(
    trackedPids.length >= 1,
    "our node process should have spawned at least one child process",
  );

  const startMs = Date.now();
  child.kill(signal);

  const completed = await Promise.race([
    exitPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`jaiph run did not exit within 5s after ${signal}`)),
        5000,
      ),
    ),
  ]);
  const elapsedMs = Date.now() - startMs;

  assert.ok(
    completed.signal === signal ||
      (typeof completed.code === "number" && completed.code !== 0),
    `expected non-zero exit or ${signal}; got code=${completed.code} signal=${completed.signal}`,
  );
  assert.ok(elapsedMs < 5000, `exit should complete within 5s; took ${elapsedMs}ms`);

  // Allow OS to reap processes
  await new Promise((r) => setTimeout(r, 300));

  const stillAlive = anyPidsAlive(trackedPids);
  assert.ok(
    !stillAlive,
    `our workflow process(es) should be gone after ${signal}; PIDs we spawned: ${trackedPids.join(", ")}`,
  );
}

test("ACCEPTANCE: jaiph run exits on SIGINT with bounded time and no stale workflow process", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-sigint-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  try {
    await runInterruptTest(root, cliPath, "SIGINT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACCEPTANCE: jaiph run exits on SIGTERM with bounded time and no stale workflow process", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-sigterm-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  try {
    await runInterruptTest(root, cliPath, "SIGTERM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
