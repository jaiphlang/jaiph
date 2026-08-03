import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunStatus } from "./types";
import { RUN_SUMMARY } from "./runfiles";
import { verifyRunJournal } from "../../runtime";

/** Result text stamped on a run whose journal chain failed integrity verification. */
export const TAMPERED_RESULT_TEXT =
  "run journal failed integrity verification: the audit chain is broken, truncated, or forged";

/**
 * The public run record persisted beside a run's journal, so `jaiph serve` can
 * reconstruct completed runs after a restart instead of losing every run id the
 * moment the process dies. Written atomically at finalize (and when an
 * interrupted run is reconciled on startup); read back by {@link loadPersistedRuns}.
 */
export const PUBLIC_RUN_FILE = "run.json";

/** Bump when the on-disk shape changes so an old file can be ignored rather than mis-parsed. */
const SCHEMA_VERSION = 1;

/** On-disk shape of {@link PUBLIC_RUN_FILE}. A superset of the public run object. */
interface PersistedRun {
  schema_version: number;
  run_id: string;
  workflow: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  exit_status: number | null;
  signal: string | null;
  result_text: string | null;
  run_dir: string | null;
  /** Composite idempotency key (`principal\nworkflow\nkey`), when the create carried one. */
  idempotency_key?: string;
  /** Authenticated principal (audit subject) that created the run; scopes idempotency + ownership. */
  principal?: string;
  /** Request/correlation id attached at create time. */
  correlation_id?: string;
  /** SHA-256 of the run's canonical arguments, for idempotency conflict detection. */
  args_hash?: string;
}

/** Result text stamped on a run reconciled from a `running` journal after process death. */
export const INTERRUPTED_RESULT_TEXT =
  "run interrupted: the serving process exited before this run reached a terminal state";

/**
 * SHA-256 (hex) of a run's canonical arguments. Keys are sorted so two requests
 * with the same parameters in a different textual order hash identically —
 * idempotency conflict detection compares this, not raw request bytes.
 */
export function hashArgs(args: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Write a run's public record beside its journal, atomically (temp file +
 * rename) so a crash mid-write can never leave a half-parsed file. A no-op when
 * the run has no discovered `run_dir` (nothing durable to sit beside). Failures
 * are swallowed: persistence is best-effort and must never fail a run or its
 * HTTP response.
 */
export function persistRunRecord(record: RunRecord): void {
  if (!record.run_dir) return;
  const persisted: PersistedRun = {
    schema_version: SCHEMA_VERSION,
    run_id: record.run_id,
    workflow: record.workflow,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.ended_at,
    exit_status: record.exit_status,
    signal: record.signal,
    result_text: record.result_text,
    run_dir: record.run_dir,
    idempotency_key: record.idempotency_key,
    principal: record.principal,
    correlation_id: record.correlation_id,
    args_hash: record.args_hash,
  };
  const target = join(record.run_dir, PUBLIC_RUN_FILE);
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(persisted), "utf8");
    renameSync(tmp, target);
  } catch {
    // Best-effort: a read-only or vanished run dir must not break the response.
  }
}

/**
 * Reconstruct the run registry from the durable runs tree at startup. Scans
 * `runsRoot` (same date/time layout as `findRunDir`) and returns one record per
 * run, oldest-first so the caller can assign monotonic order:
 *
 * - A run with a `run.json` reloads verbatim (terminal state, idempotency key).
 * - A run with a journal but no `run.json` was `running` when the process died;
 *   it is **reconciled** to the explicit terminal status `interrupted` (never
 *   left reported as permanently running) and that reconciliation is persisted
 *   so it survives a second restart.
 *
 * `runsRoot` being absent/unreadable yields an empty registry.
 */
export function loadPersistedRuns(runsRoot: string, nowIso: string): RunRecord[] {
  const records: Array<{ dir: string; record: RunRecord }> = [];
  for (const runDir of scanRunDirs(runsRoot)) {
    const record = reloadRun(runDir) ?? reconcileRun(runDir, nowIso);
    if (!record) continue;
    // Hard-fail a tampered journal (finding H-3): a run whose keyed chain does
    // not verify is surfaced as failed with an explicit tamper message rather
    // than silently trusted. Unverifiable (unkeyed/legacy) runs are unchanged.
    const integrity = verifyRunJournal(runDir);
    if (integrity.verified && !integrity.ok) {
      record.status = "failed";
      record.result_text = TAMPERED_RESULT_TEXT;
    }
    records.push({ dir: runDir, record });
  }
  // Oldest-first: the run dir name is a sortable UTC date/time, so the scan
  // order already reflects chronology once reversed back to ascending.
  records.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return records.map((r) => r.record);
}

/** Every run directory (holding a `run_summary.jsonl`) under the runs tree. */
function scanRunDirs(runsRoot: string): string[] {
  const out: string[] = [];
  let dateDirs: string[];
  try {
    dateDirs = readdirSync(runsRoot).filter((d) => !d.startsWith(".") && isDir(join(runsRoot, d)));
  } catch {
    return out;
  }
  for (const dateDir of dateDirs) {
    const datePath = join(runsRoot, dateDir);
    let timeDirs: string[];
    try {
      timeDirs = readdirSync(datePath).filter((d) => isDir(join(datePath, d)));
    } catch {
      continue;
    }
    for (const timeDir of timeDirs) {
      const runDir = join(datePath, timeDir);
      if (existsFile(join(runDir, RUN_SUMMARY)) || existsFile(join(runDir, PUBLIC_RUN_FILE))) out.push(runDir);
    }
  }
  return out;
}

/** Reload a terminal record from `run.json`; null when the file is absent or unusable. */
function reloadRun(runDir: string): RunRecord | null {
  let parsed: PersistedRun;
  try {
    parsed = JSON.parse(readFileSync(join(runDir, PUBLIC_RUN_FILE), "utf8")) as PersistedRun;
  } catch {
    return null;
  }
  if (parsed.schema_version !== SCHEMA_VERSION || typeof parsed.run_id !== "string") return null;
  return {
    run_id: parsed.run_id,
    workflow: parsed.workflow,
    status: parsed.status,
    started_at: parsed.started_at,
    ended_at: parsed.ended_at,
    exit_status: parsed.exit_status,
    signal: parsed.signal,
    result_text: parsed.result_text,
    // The scanned directory is authoritative — it is where events/artifacts live now.
    run_dir: runDir,
    cancelled: parsed.status === "cancelled",
    order: 0,
    idempotency_key: parsed.idempotency_key,
    principal: parsed.principal,
    correlation_id: parsed.correlation_id,
    args_hash: parsed.args_hash,
  };
}

/**
 * Reconcile a run that has a journal but no persisted record: it was `running`
 * when the process died. Read its identity from the `WORKFLOW_START` first line
 * and mark it `interrupted`. The reconciled record is persisted so the terminal
 * state is durable. Returns null when the journal has no usable WORKFLOW_START.
 */
function reconcileRun(runDir: string, nowIso: string): RunRecord | null {
  let firstLine: string;
  try {
    firstLine = readFileSync(join(runDir, RUN_SUMMARY), "utf8").split(/\r?\n/)[0] ?? "";
  } catch {
    return null;
  }
  let start: { type?: string; run_id?: string; workflow?: string; ts?: string };
  try {
    start = JSON.parse(firstLine) as typeof start;
  } catch {
    return null;
  }
  if (start.type !== "WORKFLOW_START" || typeof start.run_id !== "string") return null;
  const record: RunRecord = {
    run_id: start.run_id,
    workflow: typeof start.workflow === "string" ? start.workflow : "",
    status: "interrupted",
    started_at: typeof start.ts === "string" ? start.ts : nowIso,
    ended_at: nowIso,
    exit_status: null,
    signal: null,
    result_text: INTERRUPTED_RESULT_TEXT,
    run_dir: runDir,
    cancelled: false,
    order: 0,
  };
  persistRunRecord(record);
  return record;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
