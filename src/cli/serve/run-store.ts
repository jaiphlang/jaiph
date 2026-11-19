import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Marker file a serve process drops into a run directory it owns, the moment it
 * first resolves that directory for a still-running run (before any `run.json`
 * exists). It is the ownership signal startup reconciliation keys on: a run dir
 * carrying this marker (or a `run.json`) was created by a serve process and may
 * be reconciled to `interrupted`; a dir with neither — a plain `jaiph run`, or a
 * run of a still-live process in the same workspace — is left untouched.
 */
export const SERVE_MANAGED_MARKER = ".serve-managed";

/**
 * Drop the {@link SERVE_MANAGED_MARKER} into a run directory this serve process
 * owns, so a later restart may reconcile it even if it never reached a terminal
 * state. Idempotent and best-effort: an already-present marker or an unwritable
 * dir is ignored (it must never break a request).
 */
export function markServeManaged(runDir: string): void {
  const marker = join(runDir, SERVE_MANAGED_MARKER);
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, "", "utf8");
  } catch {
    // Best-effort: a read-only or vanished run dir must not break the response.
  }
}

/** Bump when the on-disk shape changes so an old file can be ignored rather than mis-parsed. */
const SCHEMA_VERSION = 2;

/** On-disk shape of {@link PUBLIC_RUN_FILE}. A superset of the public run object. */
interface PersistedRun {
  schema_version: number;
  run_id: string;
  def: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  exit_status: number | null;
  signal: string | null;
  result_text: string | null;
  run_dir: string | null;
  /** Composite idempotency key (`principal\ndef\nkey`), when the create carried one. */
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
    def: record.def,
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
 * - A run with a {@link SERVE_MANAGED_MARKER} but no `run.json` was `running`
 *   when the process died; it is **reconciled** to the explicit terminal status
 *   `interrupted` (never left reported as permanently running) and that
 *   reconciliation is persisted so it survives a second restart.
 *
 * Only run dirs this server owns (a `run.json` or the marker) are touched — a
 * plain `jaiph run` dir, or a run of a still-live process in the same workspace,
 * is neither loaded nor modified. `maxRuns > 0` applies the retention cap while
 * loading: the newest `maxRuns` owned dirs are processed and older ones are left
 * untouched (no reconciliation write), so startup memory is bounded.
 *
 * `runsRoot` being absent/unreadable yields an empty registry.
 */
export function loadPersistedRuns(runsRoot: string, nowIso: string, maxRuns = 0): RunRecord[] {
  // Owned dirs, oldest-first: the run dir path is a sortable UTC date/time.
  const dirs = scanOwnedRunDirs(runsRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Retention cap applied before any reconciliation: drop the oldest beyond the
  // cap so they are never read or stamped, keeping the newest `maxRuns`.
  const kept = maxRuns > 0 && dirs.length > maxRuns ? dirs.slice(dirs.length - maxRuns) : dirs;
  const records: RunRecord[] = [];
  for (const runDir of kept) {
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
    records.push(record);
  }
  return records;
}

/**
 * Run directories this server owns — those carrying a `run.json` (a finalized or
 * already-reconciled run) or the {@link SERVE_MANAGED_MARKER} (a run this server
 * launched that has not yet finalized). A dir with only a `run_summary.jsonl`
 * (a plain `jaiph run`, or a foreign/live process) is deliberately excluded.
 */
function scanOwnedRunDirs(runsRoot: string): string[] {
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
      if (existsFile(join(runDir, PUBLIC_RUN_FILE)) || existsFile(join(runDir, SERVE_MANAGED_MARKER))) out.push(runDir);
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
    def: parsed.def,
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
 * when the process died. Read its identity from the `RUN_START` first line
 * and mark it `interrupted`. The reconciled record is persisted so the terminal
 * state is durable. Returns null when the journal has no usable RUN_START.
 */
function reconcileRun(runDir: string, nowIso: string): RunRecord | null {
  let firstLine: string;
  try {
    firstLine = readFileSync(join(runDir, RUN_SUMMARY), "utf8").split(/\r?\n/)[0] ?? "";
  } catch {
    return null;
  }
  let start: { type?: string; run_id?: string; def?: string; ts?: string };
  try {
    start = JSON.parse(firstLine) as typeof start;
  } catch {
    return null;
  }
  if (start.type !== "RUN_START" || typeof start.run_id !== "string") return null;
  const record: RunRecord = {
    run_id: start.run_id,
    def: typeof start.def === "string" ? start.def : "",
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
