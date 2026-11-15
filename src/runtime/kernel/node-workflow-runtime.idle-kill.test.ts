import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { moduleScriptFileName } from "../../inline-script-name";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

/**
 * End-to-end idle-output kill coverage. A leaf `script` step that produces no
 * stdout/stderr for `JAIPH_STEP_IDLE_KILL_SEC` is terminated, the journal
 * records a `LOGERR` naming the step + idle duration, and the step fails. These
 * drive real subprocesses (SIGTERM/SIGKILL), so they are POSIX-only; the
 * deterministic tracker-level contract lives in step-idle-warn.test.ts.
 *
 * The journal writer (`appendRunSummaryLine`) reads `process.env`, so — like
 * node-workflow-runtime.audit-chain.test.ts — the runtime env must BE
 * `process.env`. We snapshot/restore every key touched.
 */

// Keys the runtime or the test sets on process.env; snapshot + restore all.
const TOUCHED = [
  "JAIPH_TEST_MODE", "JAIPH_RUNS_DIR", "JAIPH_SCRIPTS", "JAIPH_WORKSPACE",
  "JAIPH_RUN_DIR", "JAIPH_RUN_SUMMARY_FILE", "JAIPH_ARTIFACTS_DIR", "JAIPH_RUN_ID",
  "JAIPH_SOURCE_FILE", "JAIPH_STEP_IDLE_WARN_SEC", "JAIPH_STEP_IDLE_KILL_SEC",
  "JAIPH_STEP_IDLE_WARN_CHECK_MS",
];

type SummaryEvent = { type?: string; message?: string };

function readSummary(runDir: string): SummaryEvent[] {
  const raw = readFileSync(join(runDir, "run_summary.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SummaryEvent);
}

/**
 * Run a workflow whose single leaf is a named `script` with `scriptBody`, with
 * the idle-kill env applied. Returns the run directory (from process.env, set
 * by the runtime) and the workflow status.
 */
async function runScriptStep(
  root: string,
  scriptName: string,
  scriptBody: string,
  idleEnv: Record<string, string>,
): Promise<{ status: number; runDir: string }> {
  const jh = join(root, "flow.jh");
  writeFileSync(
    jh,
    [
      `script ${scriptName} = 'echo unused'`,
      "",
      "export def main() {",
      `  ${scriptName}()`,
      "}",
      "",
    ].join("\n"),
  );
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, moduleScriptFileName(jh, scriptName)), `#!/usr/bin/env bash\n${scriptBody}\n`);
  const graph = buildRuntimeGraph(jh);

  process.env.JAIPH_TEST_MODE = "1";
  process.env.JAIPH_RUNS_DIR = join(root, ".jaiph", "runs");
  process.env.JAIPH_SCRIPTS = scriptsDir;
  process.env.JAIPH_WORKSPACE = root;
  // Poll fast so the short kill threshold is observed promptly.
  process.env.JAIPH_STEP_IDLE_WARN_CHECK_MS = "250";
  for (const [k, v] of Object.entries(idleEnv)) process.env[k] = v;

  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: root, suppressLiveEvents: true });
  const status = await runtime.runMain([]);
  return { status, runDir: runtime.getRunDir() };
}

// AC1: a silent leaf step is terminated after the (short) kill threshold, the
// journal records the LOGERR naming the step + idle duration, and it fails.
test(
  "idle kill: a silent script step is terminated, journaled with LOGERR, and fails",
  { skip: process.platform === "win32" },
  async () => {
    const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
    const root = mkdtempSync(join(tmpdir(), "jaiph-idle-kill-"));
    try {
      const { status, runDir } = await runScriptStep(root, "hang", "sleep 30", {
        JAIPH_STEP_IDLE_WARN_SEC: "0",
        JAIPH_STEP_IDLE_KILL_SEC: "1",
      });
      assert.notEqual(status, 0, "workflow fails when the leaf step is idle-killed");

      const logerr = readSummary(runDir).find(
        (e) =>
          e.type === "LOGERR" &&
          typeof e.message === "string" &&
          /^script hang: no new output for \d+s; terminating idle step$/.test(e.message),
      );
      assert.ok(logerr, "journal records a LOGERR naming the step and idle duration");
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
);

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

// AC1 (process tree): a silent script that backgrounds a grandchild is
// idle-killed as a whole process group — the grandchild (a `sleep` in the
// script's group) is dead after the kill, not orphaned to ppid 1. This is the
// regression the detached-group spawn fixes: before it, killing the single
// script pid left the grandchild running.
test(
  "idle kill: a backgrounded grandchild of a silent step is killed with the group",
  { skip: process.platform === "win32" },
  async () => {
    const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
    const root = mkdtempSync(join(tmpdir(), "jaiph-idle-kill-tree-"));
    const pidFile = join(root, "grandchild.pid");
    try {
      // Background a long `sleep` (the grandchild), record its pid, then hang
      // the step with no output so the idle-kill fires.
      const body = `sleep 120 &\necho $! > "${pidFile}"\nsleep 120`;
      const { status } = await runScriptStep(root, "hang", body, {
        JAIPH_STEP_IDLE_WARN_SEC: "0",
        JAIPH_STEP_IDLE_KILL_SEC: "1",
      });
      assert.notEqual(status, 0, "workflow fails when the leaf step is idle-killed");

      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid recorded");
      const dead = await waitForPidDead(grandchildPid, 8000);
      assert.ok(dead, `backgrounded grandchild ${grandchildPid} must be dead after the idle-kill`);
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
);

// AC2 (end-to-end): a step that keeps emitting output resets the idle clock and
// runs to completion — the kill never fires even with a 1s threshold.
test(
  "idle kill: steady output resets the idle clock and the step completes",
  { skip: process.platform === "win32" },
  async () => {
    const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
    const root = mkdtempSync(join(tmpdir(), "jaiph-idle-nokill-"));
    try {
      const { status, runDir } = await runScriptStep(
        root,
        "chatty",
        "for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.3; done",
        { JAIPH_STEP_IDLE_WARN_SEC: "0", JAIPH_STEP_IDLE_KILL_SEC: "1" },
      );
      assert.equal(status, 0, "workflow succeeds while output keeps arriving");
      assert.equal(
        readSummary(runDir).filter((e) => e.type === "LOGERR").length,
        0,
        "no idle-kill LOGERR while the step keeps producing output",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
);
