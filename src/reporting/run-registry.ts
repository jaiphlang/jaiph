import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAppendWindow, readFullFile, type TailAccumulator } from "./jsonl-tail";
import { applySummaryLine, emptyRunState, toActiveRunInfo, toRunListEntry, type RunSummaryState } from "./summary-parser";
import { runDirFromRel } from "./path-utils";
import type { ActiveRunInfo, RunListEntry } from "./types";

export type RunSlot = {
  relPath: string;
  summaryPath: string;
  tail: TailAccumulator;
  state: RunSummaryState;
};

export type RunRegistry = {
  runsRoot: string;
  slots: Map<string, RunSlot>;
  lastDirScanMs: number;
};

const DIR_SCAN_MIN_MS = 2000;

export function createRunRegistry(runsRoot: string): RunRegistry {
  return {
    runsRoot,
    slots: new Map(),
    lastDirScanMs: 0,
  };
}

function listSummaryRelPaths(runsRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(runsRoot)) {
    return out;
  }
  let dateDirs: string[];
  try {
    dateDirs = readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const day of dateDirs) {
    const dayPath = join(runsRoot, day);
    let children: string[];
    try {
      children = readdirSync(dayPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const run of children) {
      const rel = `${day}/${run}`;
      const summary = join(dayPath, run, "run_summary.jsonl");
      if (existsSync(summary)) {
        out.push(rel);
      }
    }
  }
  return out;
}

function ingestText(state: RunSummaryState, partialRef: { value: string }, text: string): void {
  const combined = partialRef.value + text;
  const lines = combined.split("\n");
  partialRef.value = lines.pop() ?? "";
  for (const line of lines) {
    applySummaryLine(state, line);
  }
}

function ensureSlot(reg: RunRegistry, relPath: string): RunSlot {
  const existing = reg.slots.get(relPath);
  if (existing) {
    return existing;
  }
  const summaryPath = join(runDirFromRel(reg.runsRoot, relPath), "run_summary.jsonl");
  const slot: RunSlot = {
    relPath,
    summaryPath,
    tail: { partial: "" },
    state: emptyRunState(),
  };
  reg.slots.set(relPath, slot);
  return slot;
}

function fullReloadSlot(slot: RunSlot): void {
  slot.state = emptyRunState();
  slot.tail = { partial: "" };
  if (!existsSync(slot.summaryPath)) {
    return;
  }
  const body = readFullFile(slot.summaryPath);
  const partialRef = { value: "" };
  ingestText(slot.state, partialRef, body);
  slot.tail.partial = partialRef.value;
  try {
    const st = statSync(slot.summaryPath);
    slot.tail.cursor = {
      offset: st.size,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    slot.tail.cursor = undefined;
  }
}

function tailSlot(slot: RunSlot): void {
  if (!existsSync(slot.summaryPath)) {
    return;
  }
  const { chunk, needsReset } = readAppendWindow(slot.summaryPath, slot.tail);
  if (needsReset) {
    fullReloadSlot(slot);
    return;
  }
  if (chunk) {
    const partialRef = { value: slot.tail.partial };
    ingestText(slot.state, partialRef, chunk);
    slot.tail.partial = partialRef.value;
  }
}

function maybeRescanDirs(reg: RunRegistry, now: number, force: boolean): void {
  if (!force && now - reg.lastDirScanMs < DIR_SCAN_MIN_MS) {
    return;
  }
  reg.lastDirScanMs = now;
  if (!existsSync(reg.runsRoot)) {
    reg.slots.clear();
    return;
  }
  const paths = listSummaryRelPaths(reg.runsRoot);
  const set = new Set(paths);
  for (const p of paths) {
    if (!reg.slots.has(p)) {
      fullReloadSlot(ensureSlot(reg, p));
    }
  }
  for (const key of [...reg.slots.keys()]) {
    if (!set.has(key)) {
      reg.slots.delete(key);
    }
  }
}

export type PollOptions = {
  forceScan?: boolean;
};

export function pollRunRegistry(reg: RunRegistry, nowMs: number, opts?: PollOptions): void {
  maybeRescanDirs(reg, nowMs, opts?.forceScan ?? false);
  for (const slot of reg.slots.values()) {
    tailSlot(slot);
  }
}

export function getRunSlot(reg: RunRegistry, relPath: string): RunSlot | undefined {
  return reg.slots.get(relPath);
}

export function ensureRunSlotLoaded(reg: RunRegistry, relPath: string): RunSlot | undefined {
  const summaryPath = join(runDirFromRel(reg.runsRoot, relPath), "run_summary.jsonl");
  if (!existsSync(summaryPath)) {
    return undefined;
  }
  const slot = ensureSlot(reg, relPath);
  if (!slot.tail.cursor && !slot.state.run_id && slot.state.steps.size === 0) {
    fullReloadSlot(slot);
  }
  tailSlot(slot);
  return slot;
}

export function listRunEntries(reg: RunRegistry): RunListEntry[] {
  const rows: RunListEntry[] = [...reg.slots.values()].map((slot) => toRunListEntry(slot.relPath, slot.state));
  rows.sort((a, b) => {
    const ta = a.started_at ?? "";
    const tb = b.started_at ?? "";
    return tb.localeCompare(ta);
  });
  return rows;
}

export function listActiveRuns(reg: RunRegistry): ActiveRunInfo[] {
  const out: ActiveRunInfo[] = [];
  for (const slot of reg.slots.values()) {
    const row = toActiveRunInfo(slot.relPath, slot.state);
    if (row) {
      out.push(row);
    }
  }
  return out;
}
