import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bug fix: forwarded `__JAIPH_EVENT__` lines from inside an isolated branch
 * must be persisted to the host's `run_summary.jsonl` (with branch_id), not
 * just written to host stderr for the live TTY. Without this, the host has
 * no durable record of branch progress while handles resolve (~8min in the
 * engineer.jh candidate-join case) and `select_best_candidate.{out,err}` end
 * up empty with zero inner step events.
 *
 * This is a contract test against `node-workflow-runtime.ts`. A full
 * end-to-end test requires Docker; this guards the static contract so
 * future refactors do not regress the persistence path.
 */
const RUNTIME_SRC_PATH = join(
  process.cwd(),
  "src",
  "runtime",
  "kernel",
  "node-workflow-runtime.ts",
);
const RUN_CLI_SRC_PATH = join(process.cwd(), "src", "cli", "commands", "run.ts");

test("CONTRACT: executeIsolatedRunRef forwards events to host run_summary.jsonl with branch_id", () => {
  const src = readFileSync(RUNTIME_SRC_PATH, "utf8");

  assert.match(
    src,
    /persistForwardedBranchEvent\s*\(\s*line\s*,\s*branchId\s*\)/,
    "stderr forwarding must call persistForwardedBranchEvent for every __JAIPH_EVENT__ line",
  );
  assert.match(
    src,
    /branch_id:\s*branchId/,
    "persistForwardedBranchEvent must annotate forwarded events with branch_id",
  );
  assert.match(
    src,
    /appendRunSummaryLine\(JSON\.stringify\(\{\s*\.\.\.payload,\s*branch_id:\s*branchId/,
    "forwarded event payloads must be persisted via appendRunSummaryLine",
  );
});

test("CONTRACT: executeIsolatedRunRef emits BRANCH_START / BRANCH_END markers on host", () => {
  const src = readFileSync(RUNTIME_SRC_PATH, "utf8");

  assert.match(
    src,
    /type:\s*"BRANCH_START"/,
    "must emit a BRANCH_START marker so the host has a record that an isolated branch began",
  );
  assert.match(
    src,
    /type:\s*"BRANCH_END"/,
    "must emit a BRANCH_END marker so the host has a record of branch completion + status",
  );
  assert.match(
    src,
    /return_value:\s*returnValue\s*\?\?\s*null/,
    "BRANCH_END must include the resolved return_value (or null) so post-mortem inspection works",
  );
});

test("CONTRACT: executeIsolatedRunRef passes JAIPH_META_FILE to the container", () => {
  const src = readFileSync(RUNTIME_SRC_PATH, "utf8");

  assert.match(
    src,
    /JAIPH_META_FILE:\s*containerMetaPath/,
    "must inject JAIPH_META_FILE into the container env so the inner runner writes to a host-readable path",
  );
  assert.match(
    src,
    /CONTAINER_RUN_DIR\}\/\.jaiph-run-meta\.txt/,
    "the container meta path must live inside the host-mounted run dir",
  );
  assert.match(
    src,
    /readFileSync\(hostMetaPath/,
    "the host must read the meta file from the pre-allocated branchRunDir path",
  );
});

test("CONTRACT: runWorkflowRaw honors JAIPH_META_FILE env override", () => {
  const src = readFileSync(RUN_CLI_SRC_PATH, "utf8");

  assert.match(
    src,
    /process\.env\.JAIPH_META_FILE\s*\?\s*process\.env\.JAIPH_META_FILE/,
    "runWorkflowRaw must use JAIPH_META_FILE when present so the host-allocated meta path is honored",
  );
});
