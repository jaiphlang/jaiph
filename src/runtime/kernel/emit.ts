/**
 * Runtime event emission: __JAIPH_EVENT__ JSONL on the event fd + matching run_summary.jsonl lines.
 * JS is the source of truth for event JSON building. Bash stdlib delegates here with raw args.
 *
 * Modes (argv[2]):
 * - step-event — args = event fields + optional param args. Builds full STEP_START/STEP_END JSON.
 * - log / logerr — args = message. Builds LOG/LOGERR JSON (depth from JAIPH_STEP_STACK env).
 * - workflow-event — args = type, name. Builds WORKFLOW_START/WORKFLOW_END summary JSON.
 * - live — (legacy) stdin = one JSON object. Writes event line, then summary when applicable.
 * - summary-line — stdin = one complete summary JSON line (workflow / inbox / any caller-built line).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
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

function stepIdentity(funcName: string, stepKind: string): { kind: string; name: string } {
  if (stepKind) {
    const name = funcName.split("::").pop() ?? funcName;
    return { kind: stepKind, name };
  }
  if (funcName === "jaiph::prompt") return { kind: "prompt", name: "prompt" };
  return { kind: "step", name: funcName };
}

function stepStackDepth(): number {
  const stack = process.env.JAIPH_STEP_STACK ?? "";
  return stack ? stack.split(",").length : 0;
}

function buildStepParams(args: string[]): [string, string][] {
  const keys = process.env.JAIPH_STEP_PARAM_KEYS ?? "";
  if (keys) {
    const keyArr = keys.split(",");
    return keyArr.map((key, i): [string, string] => {
      const arg = args[i] ?? "";
      const val = arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : arg;
      return [key, val];
    });
  }
  return args.map((arg, i): [string, string] => [`arg${i + 1}`, arg]);
}

/** step-event: build full STEP_START/STEP_END JSON from positional args + env. */
function emitStepEvent(): void {
  const a = process.argv;
  const eventType = a[3] ?? "";
  const funcName = a[4] ?? "";
  const stepKind = a[5] ?? "";
  const statusRaw = a[6] ?? "";
  const elapsedMsRaw = a[7] ?? "";
  const outFile = a[8] ?? "";
  const errFile = a[9] ?? "";
  const stepId = a[10] ?? "";
  const parentId = a[11] ?? "";
  const seqRaw = a[12] ?? "";
  const depthRaw = a[13] ?? "";
  const paramArgs = a.slice(14);

  const { kind, name } = stepIdentity(funcName, stepKind);
  const status = statusRaw ? parseInt(statusRaw, 10) : null;
  const payload: Record<string, unknown> = {
    type: eventType,
    func: funcName,
    kind,
    name,
    ts: formatUtcTimestamp(),
    status,
    elapsed_ms: elapsedMsRaw ? parseInt(elapsedMsRaw, 10) : null,
    out_file: outFile,
    err_file: errFile,
    id: stepId,
    parent_id: parentId || null,
    seq: seqRaw ? parseInt(seqRaw, 10) : null,
    depth: depthRaw ? parseInt(depthRaw, 10) : null,
    run_id: process.env.JAIPH_RUN_ID ?? "",
  };
  if (paramArgs.length > 0) {
    payload.params = buildStepParams(paramArgs);
  }
  if (process.env.JAIPH_DISPATCH_CHANNEL) {
    payload.dispatched = true;
    payload.channel = process.env.JAIPH_DISPATCH_CHANNEL;
    if (process.env.JAIPH_DISPATCH_SENDER) {
      payload.sender = process.env.JAIPH_DISPATCH_SENDER;
    }
  }
  const MAX_EMBED = 1048576;
  if (eventType === "STEP_END") {
    if (outFile && existsSync(outFile)) {
      let c = readFileSync(outFile, "utf8");
      if (c.length > MAX_EMBED) c = `${c.slice(0, MAX_EMBED)}\n[truncated]`;
      payload.out_content = c;
    }
    if (errFile && existsSync(errFile) && status !== 0) {
      let c = readFileSync(errFile, "utf8");
      if (c.length > MAX_EMBED) c = `${c.slice(0, MAX_EMBED)}\n[truncated]`;
      payload.err_content = c;
    }
  }
  writeLivePayload(payload);
  if (process.env.JAIPH_RUN_SUMMARY_FILE) {
    appendRunSummaryLine(JSON.stringify({ ...payload, event_version: 1 }));
  }
}

/** log / logerr: build LOG or LOGERR JSON from args + JAIPH_STEP_STACK env. */
function emitLogEvent(type: "LOG" | "LOGERR"): void {
  const message = process.argv[3] ?? "";
  const depth = stepStackDepth();
  const payload = { type, message, depth };
  writeLivePayload(payload);
  if (process.env.JAIPH_RUN_SUMMARY_FILE) {
    appendRunSummaryLine(
      JSON.stringify({
        ...payload,
        ts: formatUtcTimestamp(),
        run_id: process.env.JAIPH_RUN_ID ?? "",
        event_version: 1,
      }),
    );
  }
}

/** workflow-event: build WORKFLOW_START/WORKFLOW_END summary-only JSON. */
function emitWorkflowEvent(): void {
  const wfType = process.argv[3] ?? "";
  const wfName = process.argv[4] ?? "";
  appendRunSummaryLine(
    JSON.stringify({
      type: wfType,
      workflow: wfName,
      source: process.env.JAIPH_SOURCE_FILE ?? "",
      ts: formatUtcTimestamp(),
      run_id: process.env.JAIPH_RUN_ID ?? "",
      event_version: 1,
    }),
  );
}

function main(): void {
  const mode = process.argv[2];
  if (mode === "step-event") { emitStepEvent(); return; }
  if (mode === "log") { emitLogEvent("LOG"); return; }
  if (mode === "logerr") { emitLogEvent("LOGERR"); return; }
  if (mode === "workflow-event") { emitWorkflowEvent(); return; }
  if (mode === "live") { emitLive(); return; }
  if (mode === "summary-line") { summaryLine(); return; }
  process.stderr.write("jaiph emit: unknown mode\n");
  process.exit(1);
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  main();
}
