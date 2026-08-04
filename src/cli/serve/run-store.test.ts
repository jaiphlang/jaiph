import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "./handler";
import {
  INTERRUPTED_RESULT_TEXT,
  PUBLIC_RUN_FILE,
  TAMPERED_RESULT_TEXT,
  hashArgs,
  loadPersistedRuns,
  persistRunRecord,
} from "./run-store";
import { RUN_SUMMARY } from "./runfiles";
import { writeChainKey } from "../../runtime";

const NOW = "2026-07-27T12:00:00.000Z";

function makeRunDir(root: string, dateTime: string): string {
  const [date, time] = dateTime.split("/");
  const dir = join(root, date, time);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJournal(dir: string, runId: string, workflow: string, terminal: boolean): void {
  const lines = [
    JSON.stringify({ type: "WORKFLOW_START", workflow, run_id: runId, ts: "2026-07-27T11:00:00.000Z", event_version: 1 }),
  ];
  if (terminal) {
    lines.push(JSON.stringify({ type: "WORKFLOW_END", workflow, run_id: runId, ts: "2026-07-27T11:00:05.000Z", event_version: 1 }));
  }
  writeFileSync(join(dir, RUN_SUMMARY), lines.join("\n") + "\n");
}

function terminalRecord(runId: string, runDir: string, over?: Partial<RunRecord>): RunRecord {
  return {
    run_id: runId,
    workflow: "build",
    status: "succeeded",
    started_at: "2026-07-27T11:00:00.000Z",
    ended_at: "2026-07-27T11:00:05.000Z",
    exit_status: 0,
    signal: null,
    result_text: "built",
    run_dir: runDir,
    cancelled: false,
    order: 0,
    ...over,
  };
}

test("hashArgs is order-independent and value-sensitive", () => {
  assert.equal(hashArgs({ a: "1", b: "2" }), hashArgs({ b: "2", a: "1" }));
  assert.notEqual(hashArgs({ a: "1" }), hashArgs({ a: "2" }));
});

test("persist then load round-trips a terminal run (with its idempotency key)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const dir = makeRunDir(root, "2026-07-27/11-00-00-tools");
    writeJournal(dir, "run-a", "build", true);
    persistRunRecord(terminalRecord("run-a", dir, { idempotency_key: "p\nbuild\nk1", args_hash: "h1", principal: "p" }));
    assert.ok(existsSync(join(dir, PUBLIC_RUN_FILE)), "run.json written beside the journal");

    const [rec] = loadPersistedRuns(root, NOW);
    assert.equal(rec.run_id, "run-a");
    assert.equal(rec.status, "succeeded");
    assert.equal(rec.result_text, "built");
    assert.equal(rec.run_dir, dir);
    assert.equal(rec.idempotency_key, "p\nbuild\nk1");
    assert.equal(rec.args_hash, "h1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run with a journal but no run.json is reconciled to interrupted and persisted", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const dir = makeRunDir(root, "2026-07-27/11-30-00-tools");
    // No run.json — the server died while this run was still running.
    writeJournal(dir, "run-b", "slow", false);

    const [rec] = loadPersistedRuns(root, NOW);
    assert.equal(rec.status, "interrupted", "no longer reported as running");
    assert.equal(rec.run_id, "run-b");
    assert.equal(rec.workflow, "slow");
    assert.equal(rec.ended_at, NOW);
    assert.equal(rec.result_text, INTERRUPTED_RESULT_TEXT);
    // The reconciliation is durable: run.json now exists and a second load is stable.
    assert.ok(existsSync(join(dir, PUBLIC_RUN_FILE)), "reconciled record persisted");
    const persisted = JSON.parse(readFileSync(join(dir, PUBLIC_RUN_FILE), "utf8"));
    assert.equal(persisted.status, "interrupted");
    const [again] = loadPersistedRuns(root, "2026-07-27T23:00:00.000Z");
    assert.equal(again.status, "interrupted");
    assert.equal(again.ended_at, NOW, "ended_at fixed at first reconciliation, not re-stamped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("even a run whose journal reached WORKFLOW_END is interrupted when no record was committed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const dir = makeRunDir(root, "2026-07-27/11-45-00-tools");
    writeJournal(dir, "run-c", "build", true); // journal is complete, but run.json never written
    const [rec] = loadPersistedRuns(root, NOW);
    assert.equal(rec.status, "interrupted", "outcome is unknown without a committed record — not silently succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPersistedRuns returns records oldest-first and skips dirs without a journal", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const older = makeRunDir(root, "2026-07-26/09-00-00-tools");
    writeJournal(older, "old", "build", true);
    persistRunRecord(terminalRecord("old", older));
    const newer = makeRunDir(root, "2026-07-27/09-00-00-tools");
    writeJournal(newer, "new", "build", true);
    persistRunRecord(terminalRecord("new", newer));
    // A directory with neither journal nor run.json is ignored.
    mkdirSync(join(root, "2026-07-27", "10-00-00-empty"), { recursive: true });

    const recs = loadPersistedRuns(root, NOW);
    assert.deepEqual(recs.map((r) => r.run_id), ["old", "new"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Finding H-3: run listing must not silently trust a broken/forged journal.
test("a run with a persisted key whose journal fails keyed verification is surfaced as failed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const dir = makeRunDir(root, "2026-07-27/12-00-00-tools");
    // Journal carries no valid keyed chain (the pre-fix / tampered shape).
    writeJournal(dir, "run-t", "build", true);
    persistRunRecord(terminalRecord("run-t", dir)); // run.json says "succeeded"
    // The host persisted a key for this run, so the listing boundary can verify.
    writeChainKey(dir, "k".repeat(64));

    const [rec] = loadPersistedRuns(root, NOW);
    assert.equal(rec.status, "failed", "a run that fails integrity verification is not served as succeeded");
    assert.equal(rec.result_text, TAMPERED_RESULT_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same journal loads unchanged when no key was persisted (cannot verify → do not block)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-runstore-"));
  try {
    const dir = makeRunDir(root, "2026-07-27/12-05-00-tools");
    writeJournal(dir, "run-u", "build", true);
    persistRunRecord(terminalRecord("run-u", dir));
    // No writeChainKey → unverifiable legacy run stays as recorded.
    const [rec] = loadPersistedRuns(root, NOW);
    assert.equal(rec.status, "succeeded");
    assert.equal(rec.result_text, "built");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent runs root yields an empty registry, and persist is a no-op without a run dir", () => {
  assert.deepEqual(loadPersistedRuns(join(tmpdir(), "does-not-exist-jaiph"), NOW), []);
  // No throw when the record has no run_dir.
  persistRunRecord(terminalRecord("x", "" as unknown as string, { run_dir: null }));
});
