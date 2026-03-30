import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyRunState,
  applySummaryLine,
  deriveStatus,
  toRunListEntry,
  toActiveRunInfo,
  buildStepTree,
  stepsSortedBySeq,
} from "./summary-parser";

// --- emptyRunState ---

test("emptyRunState: returns fresh empty state", () => {
  const s = emptyRunState();
  assert.equal(s.run_id, "");
  assert.equal(s.source, "");
  assert.equal(s.first_ts, null);
  assert.equal(s.last_ts, null);
  assert.equal(s.workflow_depth, 0);
  assert.equal(s.open_step_ids.size, 0);
  assert.equal(s.steps.size, 0);
  assert.equal(s.has_failure, false);
});

// --- applySummaryLine ---

test("applySummaryLine: skips empty line", () => {
  const s = emptyRunState();
  applySummaryLine(s, "");
  applySummaryLine(s, "  ");
  assert.equal(s.run_id, "");
});

test("applySummaryLine: skips malformed JSON", () => {
  const s = emptyRunState();
  applySummaryLine(s, "not-json");
  assert.equal(s.run_id, "");
});

test("applySummaryLine: sets run_id from first event", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", run_id: "abc123", ts: "2026-01-01T00:00:00Z" }));
  assert.equal(s.run_id, "abc123");
});

test("applySummaryLine: does not overwrite run_id", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", run_id: "first", ts: "2026-01-01T00:00:00Z" }));
  applySummaryLine(s, JSON.stringify({ type: "STEP_START", run_id: "second", id: "s1", ts: "2026-01-01T00:00:01Z" }));
  assert.equal(s.run_id, "first");
});

test("applySummaryLine: WORKFLOW_START increments depth", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", source: "test.jh", ts: "2026-01-01T00:00:00Z" }));
  assert.equal(s.workflow_depth, 1);
  assert.equal(s.source, "test.jh");
});

test("applySummaryLine: WORKFLOW_START uses workflow name as fallback source", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", workflow: "default", ts: "2026-01-01T00:00:00Z" }));
  assert.equal(s.source, "default");
});

test("applySummaryLine: WORKFLOW_END decrements depth", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", ts: "2026-01-01T00:00:00Z" }));
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_END", ts: "2026-01-01T00:00:01Z" }));
  assert.equal(s.workflow_depth, 0);
});

test("applySummaryLine: WORKFLOW_END does not go below 0", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_END", ts: "2026-01-01T00:00:00Z" }));
  assert.equal(s.workflow_depth, 0);
});

test("applySummaryLine: STEP_START adds step and marks running", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({
    type: "STEP_START",
    id: "s1",
    kind: "script",
    name: "build",
    func: "mod::build",
    seq: 1,
    depth: 0,
    ts: "2026-01-01T00:00:00Z",
  }));
  assert.equal(s.steps.size, 1);
  assert.ok(s.open_step_ids.has("s1"));
  const step = s.steps.get("s1")!;
  assert.equal(step.kind, "script");
  assert.equal(step.name, "build");
  assert.equal(step.running, true);
  assert.equal(step.seq, 1);
});

test("applySummaryLine: STEP_START with no id is ignored", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "STEP_START", ts: "2026-01-01T00:00:00Z" }));
  assert.equal(s.steps.size, 0);
});

test("applySummaryLine: STEP_END marks step completed", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "STEP_START", id: "s1", kind: "script", name: "build", seq: 1, ts: "2026-01-01T00:00:00Z" }));
  applySummaryLine(s, JSON.stringify({ type: "STEP_END", id: "s1", status: 0, elapsed_ms: 100, ts: "2026-01-01T00:00:01Z" }));
  assert.ok(!s.open_step_ids.has("s1"));
  const step = s.steps.get("s1")!;
  assert.equal(step.running, false);
  assert.equal(step.status, 0);
  assert.equal(step.elapsed_ms, 100);
});

test("applySummaryLine: STEP_END with non-zero status sets has_failure", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "STEP_START", id: "s1", kind: "script", name: "fail_step", seq: 1, ts: "2026-01-01T00:00:00Z" }));
  applySummaryLine(s, JSON.stringify({ type: "STEP_END", id: "s1", status: 1, ts: "2026-01-01T00:00:01Z" }));
  assert.equal(s.has_failure, true);
});

test("applySummaryLine: timestamps are tracked", () => {
  const s = emptyRunState();
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_START", ts: "2026-01-01T00:00:00Z" }));
  applySummaryLine(s, JSON.stringify({ type: "WORKFLOW_END", ts: "2026-01-01T00:00:05Z" }));
  assert.equal(s.first_ts, "2026-01-01T00:00:00Z");
  assert.equal(s.last_ts, "2026-01-01T00:00:05Z");
});

// --- deriveStatus ---

test("deriveStatus: running when steps are open", () => {
  const s = emptyRunState();
  s.open_step_ids.add("s1");
  assert.equal(deriveStatus(s), "running");
});

test("deriveStatus: running when workflow_depth > 0 and no steps", () => {
  const s = emptyRunState();
  s.workflow_depth = 1;
  assert.equal(deriveStatus(s), "running");
});

test("deriveStatus: failed when workflow_depth > 0 with completed steps", () => {
  const s = emptyRunState();
  s.workflow_depth = 1;
  s.steps.set("s1", {
    id: "s1", parent_id: null, seq: 1, depth: 0, kind: "script", name: "x",
    func: "", params: [], status: 0, elapsed_ms: 100, out_file: "", err_file: "",
    out_content: "", err_content: "", running: false,
  });
  assert.equal(deriveStatus(s), "failed");
});

test("deriveStatus: failed when has_failure", () => {
  const s = emptyRunState();
  s.has_failure = true;
  assert.equal(deriveStatus(s), "failed");
});

test("deriveStatus: completed when no open steps, depth 0, no failures", () => {
  const s = emptyRunState();
  assert.equal(deriveStatus(s), "completed");
});

// --- toRunListEntry ---

test("toRunListEntry: builds entry with correct fields", () => {
  const s = emptyRunState();
  s.run_id = "abc";
  s.source = "test.jh";
  s.first_ts = "2026-01-01T00:00:00Z";
  s.last_ts = "2026-01-01T00:00:05Z";
  const entry = toRunListEntry("runs/test.jh/abc", s);
  assert.equal(entry.run_id, "abc");
  assert.equal(entry.source, "test.jh");
  assert.equal(entry.status, "completed");
  assert.equal(entry.started_at, "2026-01-01T00:00:00Z");
  assert.equal(entry.ended_at, "2026-01-01T00:00:05Z");
});

test("toRunListEntry: ended_at is null when running", () => {
  const s = emptyRunState();
  s.open_step_ids.add("s1");
  s.last_ts = "2026-01-01T00:00:05Z";
  const entry = toRunListEntry("runs/test.jh/abc", s);
  assert.equal(entry.ended_at, null);
});

test("toRunListEntry: uses relPath basename as source fallback", () => {
  const s = emptyRunState();
  const entry = toRunListEntry("runs/hello.jh/abc", s);
  assert.equal(entry.source, "abc");
});

// --- toActiveRunInfo ---

test("toActiveRunInfo: returns null when not running", () => {
  const s = emptyRunState();
  assert.equal(toActiveRunInfo("path", s), null);
});

test("toActiveRunInfo: returns info when running", () => {
  const s = emptyRunState();
  s.run_id = "abc";
  s.source = "test.jh";
  s.open_step_ids.add("s1");
  s.steps.set("s1", {
    id: "s1", parent_id: null, seq: 1, depth: 0, kind: "script", name: "build",
    func: "", params: [], status: null, elapsed_ms: null, out_file: "", err_file: "",
    out_content: "", err_content: "", running: true,
  });
  const info = toActiveRunInfo("path", s)!;
  assert.ok(info);
  assert.equal(info.run_id, "abc");
  assert.equal(info.current_step_label, "script:build");
  assert.equal(info.step_running, 1);
});

// --- buildStepTree ---

test("buildStepTree: builds parent-child relationships", () => {
  const s = emptyRunState();
  const makeRow = (id: string, parentId: string | null, seq: number) => ({
    id, parent_id: parentId, seq, depth: 0, kind: "script", name: id,
    func: "", params: [] as Array<[string, string]>, status: 0, elapsed_ms: 100,
    out_file: "", err_file: "", out_content: "", err_content: "", running: false,
  });
  s.steps.set("root", makeRow("root", null, 1));
  s.steps.set("child1", makeRow("child1", "root", 2));
  s.steps.set("child2", makeRow("child2", "root", 3));
  const { roots } = buildStepTree(s);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, "root");
  assert.equal(roots[0].children.length, 2);
  assert.equal(roots[0].children[0].id, "child1");
  assert.equal(roots[0].children[1].id, "child2");
});

test("buildStepTree: sorts by seq", () => {
  const s = emptyRunState();
  const makeRow = (id: string, seq: number) => ({
    id, parent_id: null, seq, depth: 0, kind: "script", name: id,
    func: "", params: [] as Array<[string, string]>, status: 0, elapsed_ms: 100,
    out_file: "", err_file: "", out_content: "", err_content: "", running: false,
  });
  s.steps.set("b", makeRow("b", 3));
  s.steps.set("a", makeRow("a", 1));
  s.steps.set("c", makeRow("c", 2));
  const { roots } = buildStepTree(s);
  assert.deepStrictEqual(roots.map((r) => r.id), ["a", "c", "b"]);
});

// --- stepsSortedBySeq ---

test("stepsSortedBySeq: returns steps in seq order", () => {
  const s = emptyRunState();
  const makeRow = (id: string, seq: number | null) => ({
    id, parent_id: null, seq, depth: 0, kind: "script", name: id,
    func: "", params: [] as Array<[string, string]>, status: 0, elapsed_ms: 100,
    out_file: "", err_file: "", out_content: "", err_content: "", running: false,
  });
  s.steps.set("c", makeRow("c", 3));
  s.steps.set("a", makeRow("a", 1));
  s.steps.set("b", makeRow("b", 2));
  const sorted = stepsSortedBySeq(s);
  assert.deepStrictEqual(sorted.map((r) => r.id), ["a", "b", "c"]);
});

test("stepsSortedBySeq: null seq sorts last", () => {
  const s = emptyRunState();
  const makeRow = (id: string, seq: number | null) => ({
    id, parent_id: null, seq, depth: 0, kind: "script", name: id,
    func: "", params: [] as Array<[string, string]>, status: 0, elapsed_ms: 100,
    out_file: "", err_file: "", out_content: "", err_content: "", running: false,
  });
  s.steps.set("a", makeRow("a", 1));
  s.steps.set("b", makeRow("b", null));
  const sorted = stepsSortedBySeq(s);
  assert.equal(sorted[0].id, "a");
  assert.equal(sorted[1].id, "b");
});
