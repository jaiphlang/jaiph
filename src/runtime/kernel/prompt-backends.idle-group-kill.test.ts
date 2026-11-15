// Real-process coverage for the prompt watchdog's group kill. A custom agent
// backend that backgrounds a grandchild and then produces no output is killed by
// the idle layer of the watchdog. Because the backend is now spawned in its own
// process group (detached on POSIX), the watchdog's `killProcessTreeEscalating`
// signals the whole group, so the backgrounded grandchild dies with the backend
// rather than surviving as an orphan. POSIX-only (real SIGTERM/SIGKILL to a
// process group); the deterministic settle contract lives in
// prompt-backends.signal.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackend, type PromptConfig } from "./prompt";

function makeConfig(overrides: Partial<PromptConfig>): PromptConfig {
  return {
    backend: "cursor",
    agentCommand: "cursor-agent",
    model: "",
    workspaceRoot: "/ws",
    trustedWorkspace: "/ws",
    cursorFlags: [],
    claudeFlags: [],
    codexApiKey: "",
    codexApiUrl: "https://api.openai.com/v1/chat/completions",
    promptFinalFile: "",
    ...overrides,
  };
}

const noopWriter = { writeReasoning: () => {}, writeFinal: () => {} };

/** True while `pid` is a signalable live process (ESRCH once it is reaped). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

test(
  "prompt watchdog: a backgrounded grandchild of a timed-out backend is killed with the group",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-idle-tree-"));
    const pidFile = join(root, "grandchild.pid");
    const agent = join(root, "fake-agent");
    // The fake backend backgrounds a long `sleep` (the grandchild), records its
    // pid to $1, then hangs with no output so the idle watchdog layer fires.
    writeFileSync(
      agent,
      `#!/usr/bin/env bash\nsleep 120 &\necho $! > "$1"\nsleep 120\n`,
      { mode: 0o755 },
    );
    chmodSync(agent, 0o755);

    const stderr = new PassThrough();
    try {
      // A custom command (basename !== cursor-agent) with a short idle timeout
      // and the absolute cap / completion grace disabled: only the idle layer
      // can fire, and it fires fast.
      const config = makeConfig({
        backend: "cursor",
        agentCommand: `${agent} ${pidFile}`,
        idleTimeoutMs: 600,
        maxDurationMs: 0,
        completionGraceMs: 0,
      });
      const result = await runBackend(config, "hi", noopWriter, {}, stderr);
      assert.equal(result.status, 1, "an idle-killed backend fails the prompt step");

      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid recorded");
      const dead = await waitForPidDead(grandchildPid, 8000);
      assert.ok(dead, `backgrounded grandchild ${grandchildPid} must be dead after the watchdog kill`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
