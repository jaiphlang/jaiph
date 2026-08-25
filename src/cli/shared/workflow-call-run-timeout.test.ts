import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadGeneration } from "./generation";
import { callWorkflow } from "./workflow-call";

/**
 * AC2: the parent-enforced wall-clock timeout (`JAIPH_RUN_TIMEOUT`) shared with
 * `jaiph run` host mode also bounds the host spawn behind `jaiph serve` /
 * `jaiph mcp` calls (`callWorkflow` → `callWorkflowHost`). A workflow that would
 * otherwise run for 30s is terminated by the timeout, returning an error result
 * — this fails if the arming is removed from `callWorkflowHost`.
 */
test("callWorkflow (serve/mcp host path): a run exceeding JAIPH_RUN_TIMEOUT is terminated", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-call-timeout-ws-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-call-timeout-gen-"));
  try {
    const jh = join(root, "slow.jh");
    // Bare shell line → a managed `exec` shell step that sleeps well past the budget.
    writeFileSync(jh, ["workflow default() {", "  sleep 30", "}", ""].join("\n"));

    const gen = loadGeneration(jh, root, tempRoot, 1, { JAIPH_RUN_TIMEOUT: "1" }, () => {}, "test");
    assert.ok(gen.state, `generation failed: ${gen.failures.join("\n")}`);

    const startedAt = Date.now();
    const result = await callWorkflow(gen.state.callEnv, "default", [], randomUUID());
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.isError, true, "an over-budget call must return an error result");
    assert.match(result.text, /terminated by signal/, "the call was killed, not left to run 30s");
    assert.ok(elapsedMs < 15_000, `terminated near the 1s budget, not after 30s (elapsed ${elapsedMs}ms)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
