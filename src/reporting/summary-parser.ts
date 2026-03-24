import { basename } from "node:path";
import type { ActiveRunInfo, RunDerivedStatus, RunListEntry, StepRow, StepTreeNode } from "./types";

export type RunSummaryState = {
  run_id: string;
  source: string;
  first_ts: string | null;
  last_ts: string | null;
  workflow_depth: number;
  open_step_ids: Set<string>;
  /** Canonical step rows (STEP_START + optional STEP_END merge). */
  steps: Map<string, StepRow>;
  has_failure: boolean;
};

export function emptyRunState(): RunSummaryState {
  return {
    run_id: "",
    source: "",
    first_ts: null,
    last_ts: null,
    workflow_depth: 0,
    open_step_ids: new Set(),
    steps: new Map(),
    has_failure: false,
  };
}

function touchTs(state: RunSummaryState, ts: string | undefined): void {
  if (!ts) {
    return;
  }
  if (!state.first_ts) {
    state.first_ts = ts;
  }
  state.last_ts = ts;
}

function readParams(ev: Record<string, unknown>): Array<[string, string]> {
  const raw = ev.params;
  const out: Array<[string, string]> = [];
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === "string" && typeof entry[1] === "string") {
      out.push([entry[0], entry[1]]);
    }
  }
  return out;
}

function baseStepFromEvent(ev: Record<string, unknown>): Partial<StepRow> {
  return {
    kind: typeof ev.kind === "string" ? ev.kind : "",
    name: typeof ev.name === "string" ? ev.name : "",
    func: typeof ev.func === "string" ? ev.func : "",
    parent_id: typeof ev.parent_id === "string" ? ev.parent_id : null,
    seq: typeof ev.seq === "number" ? ev.seq : null,
    depth: typeof ev.depth === "number" ? ev.depth : null,
    params: readParams(ev),
    status: typeof ev.status === "number" ? ev.status : null,
    elapsed_ms: typeof ev.elapsed_ms === "number" ? ev.elapsed_ms : null,
    out_file: typeof ev.out_file === "string" ? ev.out_file : "",
    err_file: typeof ev.err_file === "string" ? ev.err_file : "",
    out_content: typeof ev.out_content === "string" ? ev.out_content : "",
    err_content: typeof ev.err_content === "string" ? ev.err_content : "",
  };
}

function ensureStep(state: RunSummaryState, id: string): StepRow {
  let row = state.steps.get(id);
  if (!row) {
    row = {
      id,
      parent_id: null,
      seq: null,
      depth: null,
      kind: "",
      name: "",
      func: "",
      params: [],
      status: null,
      elapsed_ms: null,
      out_file: "",
      err_file: "",
      out_content: "",
      err_content: "",
      running: false,
    };
    state.steps.set(id, row);
  }
  return row;
}

export function applySummaryLine(state: RunSummaryState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const t = ev.type;
  const ts = typeof ev.ts === "string" ? ev.ts : undefined;
  touchTs(state, ts);

  if (typeof ev.run_id === "string" && ev.run_id && !state.run_id) {
    state.run_id = ev.run_id;
  }

  if (t === "WORKFLOW_START") {
    state.workflow_depth += 1;
    if (typeof ev.source === "string" && ev.source) {
      state.source = basename(ev.source);
    } else if (typeof ev.workflow === "string" && ev.workflow && !state.source) {
      state.source = ev.workflow;
    }
  } else if (t === "WORKFLOW_END") {
    state.workflow_depth = Math.max(0, state.workflow_depth - 1);
    touchTs(state, ts);
  } else if (t === "STEP_START") {
    const id = typeof ev.id === "string" ? ev.id : "";
    if (!id) {
      return;
    }
    state.open_step_ids.add(id);
    const row = ensureStep(state, id);
    Object.assign(row, baseStepFromEvent(ev), { id, running: true });
  } else if (t === "STEP_END") {
    const id = typeof ev.id === "string" ? ev.id : "";
    if (!id) {
      return;
    }
    state.open_step_ids.delete(id);
    const row = ensureStep(state, id);
    Object.assign(row, baseStepFromEvent(ev), { id, running: false });
    if (typeof row.status === "number" && row.status !== 0) {
      state.has_failure = true;
    }
  }
}

export function deriveStatus(state: RunSummaryState): RunDerivedStatus {
  if (state.open_step_ids.size > 0) {
    return "running";
  }
  // Cancellation can leave unmatched WORKFLOW_START without WORKFLOW_END.
  // If no step is currently running, treat this as a terminated run.
  if (state.workflow_depth > 0) {
    if (state.steps.size === 0) {
      return "running";
    }
    return "failed";
  }
  if (state.has_failure) {
    return "failed";
  }
  return "completed";
}

function stepCounts(state: RunSummaryState): { total: number; completed: number; running: number } {
  let running = 0;
  let completed = 0;
  for (const s of state.steps.values()) {
    if (s.running) {
      running += 1;
    } else {
      completed += 1;
    }
  }
  return { total: state.steps.size, completed, running };
}

export function toRunListEntry(relPath: string, state: RunSummaryState): RunListEntry {
  const { total, completed, running } = stepCounts(state);
  const status = deriveStatus(state);
  return {
    relPath,
    run_id: state.run_id,
    source: state.source || basename(relPath),
    started_at: state.first_ts,
    ended_at: status === "running" ? null : state.last_ts,
    status,
    step_total: total,
    step_completed: completed,
    step_running: running,
    has_failure: state.has_failure,
  };
}

export function toActiveRunInfo(relPath: string, state: RunSummaryState): ActiveRunInfo | null {
  if (deriveStatus(state) !== "running") {
    return null;
  }
  const { total, completed, running } = stepCounts(state);
  let current: StepRow | undefined;
  for (const s of state.steps.values()) {
    if (s.running) {
      current = s;
      break;
    }
  }
  const label = current ? `${current.kind}:${current.name}` : null;
  let percent: number | null = null;
  if (total > 0 && completed + running <= total) {
    percent = Math.min(99, Math.round((completed / total) * 100));
  }
  return {
    relPath,
    run_id: state.run_id,
    source: state.source || basename(relPath),
    status: "running",
    step_total: total,
    step_completed: completed,
    step_running: running,
    percent,
    current_step_label: label,
  };
}

export function buildStepTree(state: RunSummaryState): { roots: StepTreeNode[]; nodes: StepTreeNode[] } {
  const nodes = new Map<string, StepTreeNode>();
  for (const row of state.steps.values()) {
    nodes.set(row.id, { ...row, children: [] });
  }
  const roots: StepTreeNode[] = [];
  for (const node of nodes.values()) {
    const pid = node.parent_id;
    if (pid && nodes.has(pid)) {
      nodes.get(pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const seqKey = (n: StepTreeNode): number => n.seq ?? 1e9;
  const sortRecursive = (list: StepTreeNode[]): void => {
    list.sort((a, b) => seqKey(a) - seqKey(b));
    for (const n of list) {
      sortRecursive(n.children);
    }
  };
  sortRecursive(roots);
  return { roots, nodes: [...nodes.values()] };
}

export function stepsSortedBySeq(state: RunSummaryState): StepRow[] {
  return [...state.steps.values()].sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9));
}
