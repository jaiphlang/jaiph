import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Return PIDs matching pattern whose parent is parentPid (direct children only). */
function findChildPidsMatching(parentPid: number, pattern: string): number[] {
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

/** Return true if any of the given PIDs are still running. */
function anyPidsAlive(pids: number[]): boolean {
  if (pids.length === 0) return false;
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
    ["workflow default {", "  sleep 120", "}"].join("\n"),
  );

  const child = spawn("node", [cliPath, "run", workflowPath], {
    stdio: "pipe",
    cwd: root,
    env: { ...process.env },
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
  assert.ok(
    ourJaiphRunPids.length >= 1,
    "our node process should have spawned at least one jaiph-run process",
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

  const stillAlive = anyPidsAlive(ourJaiphRunPids);
  assert.ok(
    !stillAlive,
    `our jaiph-run workflow process(es) should be gone after ${signal}; PIDs we spawned: ${ourJaiphRunPids.join(", ")}`,
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
