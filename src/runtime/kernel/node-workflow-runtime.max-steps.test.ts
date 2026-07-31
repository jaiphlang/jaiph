import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";

/** A `for` loop over N lines — a runaway-shaped workflow with many steps. */
function loopWorkflow(root: string): string {
  const jh = join(root, "loop.jh");
  writeFileSync(
    jh,
    [
      "workflow default(items) {",
      "  for line in items {",
      '    log "item ${line}"',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return jh;
}

const EIGHT_LINES = "a\nb\nc\nd\ne\nf\ng\nh";

/** Distinct loop items (`item a` … `item h`) that appear anywhere in the journal. */
function distinctItemsLogged(summary: string): number {
  const seen = new Set((summary.match(/item ([a-h])/g) ?? []).map((m) => m.slice(-1)));
  return seen.size;
}

/**
 * Run one workflow and return its status + durable journal text. `appendRunSummaryLine`
 * reads `process.env.JAIPH_RUN_SUMMARY_FILE`, so it is pointed at this run's journal
 * for the duration (mirrors `node-workflow-runtime.artifacts.test.ts`).
 */
async function runAndReadJournal(
  root: string,
  extraEnv: Record<string, string | undefined>,
): Promise<{ status: number; summary: string; aborted: boolean }> {
  const graph = buildRuntimeGraph(loopWorkflow(root));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_TEST_MODE: "1",
    JAIPH_RUNS_DIR: join(root, ".jaiph", "runs"),
    ...extraEnv,
  };
  const runtime = new NodeWorkflowRuntime(graph, { env, cwd: root, suppressLiveEvents: true });
  const prevSummaryEnv = process.env.JAIPH_RUN_SUMMARY_FILE;
  process.env.JAIPH_RUN_SUMMARY_FILE = runtime.getSummaryFile();
  try {
    const status = await runtime.runDefault([EIGHT_LINES]);
    const summary = readFileSync(runtime.getSummaryFile(), "utf8");
    return { status, summary, aborted: runtime.isAborted() };
  } finally {
    if (prevSummaryEnv === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
    else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryEnv;
  }
}

test("JAIPH_MAX_STEPS: a runaway loop trips the circuit breaker and the run ends non-zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-maxsteps-trip-"));
  try {
    const { status, summary, aborted } = await runAndReadJournal(root, { JAIPH_MAX_STEPS: "3" });
    assert.notEqual(status, 0, "run must fail once the step cap is exceeded");
    assert.equal(aborted, true, "the breaker aborts the runtime");
    assert.match(summary, /E_MAX_STEPS/, "the durable journal records the breaker trip");
    // The breaker stopped execution early: not every loop iteration ran.
    assert.ok(distinctItemsLogged(summary) < 8, "fewer than all 8 loop iterations ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JAIPH_MAX_STEPS: unset — the same loop runs to completion (breaker disabled by default)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-maxsteps-off-"));
  try {
    const { status, summary } = await runAndReadJournal(root, { JAIPH_MAX_STEPS: undefined });
    assert.equal(status, 0, "run completes when the breaker is disabled");
    assert.doesNotMatch(summary, /E_MAX_STEPS/);
    assert.equal(distinctItemsLogged(summary), 8, "every loop iteration ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
