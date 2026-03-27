/**
 * Runtime event emission: __JAIPH_EVENT__ JSONL on the event fd + matching run_summary.jsonl lines.
 * Invoked from Bash (events.sh) so JSON building stays in one place and live vs summary ordering is fixed.
 *
 * Modes (argv[2]):
 * - live — stdin = one JSON object (live __JAIPH_EVENT__ payload). Writes event line, then summary when applicable.
 * - summary-line — stdin = one complete summary JSON line (workflow / inbox / any caller-built line).
 */
import { appendFileSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock, releaseLock } from "./fs-lock";

/** UTC timestamp matching `date -u +"%Y-%m-%dT%H:%M:%SZ"` (no milliseconds). */
export function formatUtcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function appendRunSummaryLine(line: string): void {
  const file = process.env.JAIPH_RUN_SUMMARY_FILE;
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const parallel = process.env.JAIPH_INBOX_PARALLEL === "true";
  const lockPath = `${file}.lock`;
  if (parallel) {
    if (!acquireLock(lockPath)) process.exit(1);
  }
  try {
    appendFileSync(file, `${line}\n`, { flag: "a" });
  } finally {
    if (parallel) {
      releaseLock(lockPath);
    }
  }
}

function writeLivePayload(obj: Record<string, unknown>): void {
  const rawFd = process.env.JAIPH_EVENT_FD;
  const fd = rawFd !== undefined && rawFd !== "" ? parseInt(rawFd, 10) : 2;
  const body = `__JAIPH_EVENT__ ${JSON.stringify(obj)}\n`;
  try {
    writeSync(fd, body);
  } catch {
    writeSync(2, body);
  }
}

function readStdinJsonLine(): Record<string, unknown> {
  const input = readFileSync(0, "utf8");
  const line = input.replace(/\r?\n$/, "");
  return JSON.parse(line) as Record<string, unknown>;
}

function emitLive(): void {
  const obj = readStdinJsonLine();
  writeLivePayload(obj);
  const t = obj.type;
  if (!process.env.JAIPH_RUN_SUMMARY_FILE) {
    return;
  }
  if (t === "LOG" || t === "LOGERR") {
    const summary: Record<string, unknown> = {
      ...obj,
      ts: formatUtcTimestamp(),
      run_id: process.env.JAIPH_RUN_ID ?? "",
      event_version: 1,
    };
    appendRunSummaryLine(JSON.stringify(summary));
    return;
  }
  if (t === "STEP_START" || t === "STEP_END") {
    const summary: Record<string, unknown> = { ...obj, event_version: 1 };
    appendRunSummaryLine(JSON.stringify(summary));
  }
}

function summaryLine(): void {
  const input = readFileSync(0, "utf8");
  const line = input.replace(/\r?\n$/, "");
  appendRunSummaryLine(line);
}

function main(): void {
  const mode = process.argv[2];
  if (mode === "live") {
    emitLive();
    return;
  }
  if (mode === "summary-line") {
    summaryLine();
    return;
  }
  process.stderr.write("jaiph emit: expected mode live or summary-line\n");
  process.exit(1);
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  main();
}
