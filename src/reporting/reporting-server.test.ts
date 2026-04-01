import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeRelativeRunPath, resolveRunsRoot, runDirFromRel } from "./path-utils";
import {
  applySummaryLine,
  buildStepTree,
  deriveStatus,
  emptyRunState,
  stepsSortedBySeq,
} from "./summary-parser";
import { safeArtifactPath } from "./artifact-path";
import { createRunRegistry, listRunEntries, pollRunRegistry } from "./run-registry";

test("safeRelativeRunPath rejects traversal", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jaiph-rpt-")));
  try {
    assert.equal(safeRelativeRunPath(root, encodeURIComponent("../secret")), null);
    assert.equal(safeRelativeRunPath(root, encodeURIComponent("2025-01-01/../../etc/passwd")), null);
    const ok = safeRelativeRunPath(root, encodeURIComponent("2025-01-01/run-a"));
    assert.equal(ok, "2025-01-01/run-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary-parser builds parent/child tree by seq", () => {
  const st = emptyRunState();
  const lines = [
    '{"type":"WORKFLOW_START","workflow":"default","source":"/tmp/x.jh","ts":"2025-01-01T00:00:00Z","run_id":"r1","event_version":1}',
    '{"type":"STEP_START","func":"f","kind":"workflow","name":"outer","ts":"2025-01-01T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"a","parent_id":null,"seq":1,"depth":0,"run_id":"r1","params":[],"event_version":1}',
    '{"type":"STEP_START","func":"g","kind":"shell","name":"inner","ts":"2025-01-01T00:00:02Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"b","parent_id":"a","seq":2,"depth":1,"run_id":"r1","params":[],"event_version":1}',
    '{"type":"STEP_END","func":"g","kind":"shell","name":"inner","ts":"2025-01-01T00:00:03Z","status":0,"elapsed_ms":1,"out_file":"/x.inner.out","err_file":"","id":"b","parent_id":"a","seq":2,"depth":1,"run_id":"r1","params":[],"out_content":"hi","event_version":1}',
    '{"type":"STEP_END","func":"f","kind":"workflow","name":"outer","ts":"2025-01-01T00:00:04Z","status":0,"elapsed_ms":2,"out_file":"","err_file":"","id":"a","parent_id":null,"seq":1,"depth":0,"run_id":"r1","params":[],"event_version":1}',
    '{"type":"WORKFLOW_END","workflow":"default","source":"/tmp/x.jh","ts":"2025-01-01T00:00:05Z","run_id":"r1","event_version":1}',
  ];
  for (const ln of lines) {
    applySummaryLine(st, ln);
  }
  const { roots } = buildStepTree(st);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, "a");
  assert.equal(roots[0].children.length, 1);
  assert.equal(roots[0].children[0].id, "b");
  const ordered = stepsSortedBySeq(st);
  assert.equal(ordered[0].id, "a");
  assert.equal(ordered[1].id, "b");
});

test("run-registry discovers run_summary.jsonl and tails new lines", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-rpt-reg-"));
  try {
    const runsRoot = join(root, "runs");
    const day = join(runsRoot, "2099-01-01", "demo-run");
    mkdirSync(day, { recursive: true });
    const summary = join(day, "run_summary.jsonl");
    writeFileSync(
      summary,
      [
        '{"type":"WORKFLOW_START","workflow":"default","source":"/t.jh","ts":"2099-01-01T00:00:00Z","run_id":"rx","event_version":1}',
        '{"type":"STEP_START","func":"f","kind":"shell","name":"s","ts":"2099-01-01T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"rx","params":[],"event_version":1}',
        "",
      ].join("\n"),
    );
    const reg = createRunRegistry(resolveRunsRoot(root, "runs"));
    pollRunRegistry(reg, Date.now(), { forceScan: true });
    let entries = listRunEntries(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "running");

    appendFileSync(
      summary,
      [
        '{"type":"STEP_END","func":"f","kind":"shell","name":"s","ts":"2099-01-01T00:00:02Z","status":0,"elapsed_ms":3,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"rx","params":[],"out_content":"done","event_version":1}',
        '{"type":"WORKFLOW_END","workflow":"default","source":"/t.jh","ts":"2099-01-01T00:00:03Z","run_id":"rx","event_version":1}',
        "",
      ].join("\n"),
    );
    pollRunRegistry(reg, Date.now() + 10_000, { forceScan: false });
    entries = listRunEntries(reg);
    assert.equal(entries[0].status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safeArtifactPath keeps paths under runs root", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jaiph-rpt-art-")));
  try {
    const day = join(root, "2099-02-02", "r1");
    mkdirSync(day, { recursive: true });
    const out = join(day, "step.out");
    writeFileSync(out, "body");
    const realOut = realpathSync(out);
    assert.equal(safeArtifactPath(root, realOut), realOut);
    assert.equal(safeArtifactPath(root, join(tmpdir(), "nope")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDirFromRel resolves posix rel path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jaiph-rpt-rd-")));
  try {
    const p = runDirFromRel(root, "a/b");
    assert.match(p, /[\\/]a[\\/]b$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-registry marks stale running run as failed (SIGKILL detection)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-rpt-stale-"));
  try {
    const runsRoot = join(root, "runs");
    const day = join(runsRoot, "2099-01-01", "killed-run");
    mkdirSync(day, { recursive: true });
    const summary = join(day, "run_summary.jsonl");
    // Simulate a run that started a step but never finished (SIGKILL scenario).
    writeFileSync(
      summary,
      [
        '{"type":"WORKFLOW_START","workflow":"default","source":"/t.jh","ts":"2099-01-01T00:00:00Z","run_id":"rk","event_version":1}',
        '{"type":"STEP_START","func":"f","kind":"shell","name":"s","ts":"2099-01-01T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"rk","params":[],"event_version":1}',
        "",
      ].join("\n"),
    );
    const reg = createRunRegistry(resolveRunsRoot(root, "runs"));
    // First poll: run is detected as running.
    pollRunRegistry(reg, Date.now(), { forceScan: true, staleThresholdMs: 60_000 });
    let entries = listRunEntries(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "running");

    // Second poll: simulate time passing beyond the stale threshold.
    // The file mtime stays the same, and now - mtime > threshold.
    const farFuture = Date.now() + 120_000;
    pollRunRegistry(reg, farFuture, { forceScan: false, staleThresholdMs: 60_000 });
    entries = listRunEntries(reg);
    assert.equal(entries[0].status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-registry does not mark completed runs as stale", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-rpt-nostale-"));
  try {
    const runsRoot = join(root, "runs");
    const day = join(runsRoot, "2099-01-01", "good-run");
    mkdirSync(day, { recursive: true });
    const summary = join(day, "run_summary.jsonl");
    writeFileSync(
      summary,
      [
        '{"type":"WORKFLOW_START","workflow":"default","source":"/t.jh","ts":"2099-01-01T00:00:00Z","run_id":"rg","event_version":1}',
        '{"type":"STEP_START","func":"f","kind":"shell","name":"s","ts":"2099-01-01T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"rg","params":[],"event_version":1}',
        '{"type":"STEP_END","func":"f","kind":"shell","name":"s","ts":"2099-01-01T00:00:02Z","status":0,"elapsed_ms":1,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"rg","params":[],"out_content":"ok","event_version":1}',
        '{"type":"WORKFLOW_END","workflow":"default","source":"/t.jh","ts":"2099-01-01T00:00:03Z","run_id":"rg","event_version":1}',
        "",
      ].join("\n"),
    );
    const reg = createRunRegistry(resolveRunsRoot(root, "runs"));
    const farFuture = Date.now() + 120_000;
    pollRunRegistry(reg, farFuture, { forceScan: true, staleThresholdMs: 1 });
    const entries = listRunEntries(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveStatus marks incomplete workflow without open steps as failed", () => {
  const st = emptyRunState();
  applySummaryLine(
    st,
    '{"type":"WORKFLOW_START","workflow":"default","source":"/tmp/x.jh","ts":"2025-01-01T00:00:00Z","run_id":"r1","event_version":1}',
  );
  applySummaryLine(
    st,
    '{"type":"STEP_START","func":"f","kind":"shell","name":"s","ts":"2025-01-01T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"r1","params":[],"event_version":1}',
  );
  applySummaryLine(
    st,
    '{"type":"STEP_END","func":"f","kind":"shell","name":"s","ts":"2025-01-01T00:00:02Z","status":0,"elapsed_ms":1,"out_file":"","err_file":"","id":"s1","parent_id":null,"seq":1,"depth":0,"run_id":"r1","params":[],"event_version":1}',
  );
  assert.equal(deriveStatus(st), "failed");
});
