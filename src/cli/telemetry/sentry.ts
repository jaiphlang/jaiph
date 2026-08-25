/**
 * Sentry error reporting for a failed run.
 *
 * Fires host-side, after a run reaches an *unsuccessful* terminal state, from
 * the shared post-run telemetry hook (`exportRunTelemetry` in `otlp.ts`) — never
 * inside the runtime/emitter. Successful
 * runs send nothing. Enabled iff `SENTRY_DSN` is set.
 *
 * The event is built entirely from the run's `run_summary.jsonl`, which is
 * already credential-redacted and host-visible, so a
 * secret in step output reaches Sentry only as `[REDACTED]`. The raw per-step
 * capture files are never read.
 *
 * Zero runtime dependencies: a single hand-rolled Sentry *envelope* POST over
 * the shared timeout-guarded HTTP helper. Never load-bearing — an unreachable
 * or erroring Sentry, a malformed DSN, or a timeout produces exactly one stderr
 * warning and never touches the run's exit code, output, or journal. No retries.
 */
import { existsSync, readFileSync } from "node:fs";
import { errText } from "../../errors";
import { basename, join } from "node:path";
import { VERSION } from "../../version";
import { postWithTimeout } from "./http";
import { verifyRunJournal } from "../../runtime";
import type { ExportOutcome, ExportRunTelemetryOptions } from "./types";

/** Default hard cap on the envelope POST when no flush budget is supplied. */
const SEND_TIMEOUT_MS = 10_000;

/** Default warning sink — a single stderr line, matching the OTLP exporter. */
function stderrWarn(msg: string): void {
  process.stderr.write(msg);
}

type JournalEvent = Record<string, unknown>;

/** A parsed DSN: where to POST and the auth header to send. */
export interface SentryDsn {
  endpoint: string;
  authHeader: string;
}

/** Metadata the pure event builder needs beyond the journal lines themselves. */
export interface SentryEventMeta {
  /** Root def symbol(`main` for `jaiph run`, the tool symbol for MCP). */
  def: string;
  /** Child exit status; part of the failure message when no signal. */
  exitStatus: number;
  /** Terminating signal, when the run was killed; wins over exit code in the message. */
  signal: string | null;
  /** Absolute host run directory, surfaced as `extra.run_dir`. */
  runDir?: string;
  /** `release` field — `SENTRY_RELEASE` or `jaiph@<VERSION>`. */
  release: string;
  /** `environment` field — set only when `SENTRY_ENVIRONMENT` is present. */
  environment?: string;
  /** Authenticated caller (audit subject) — a Sentry tag; never a token. */
  principal?: string;
  /** Request/correlation id — a Sentry tag. */
  correlationId?: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse a Sentry DSN `https://<key>@<host>/<projectId>` into the envelope
 * endpoint `https://<host>/api/<projectId>/envelope/` and the `X-Sentry-Auth`
 * header value. Returns null for any malformed DSN (missing key, unparseable
 * URL, or a non-single-segment project id) — the caller warns once and sends
 * nothing.
 */
export function parseSentryDsn(dsn: string): SentryDsn | null {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  const key = url.username;
  const projectId = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!key || !url.hostname || !projectId || projectId.includes("/")) return null;
  const portSuffix = url.port ? `:${url.port}` : "";
  const endpoint = `${url.protocol}//${url.hostname}${portSuffix}/api/${projectId}/envelope/`;
  const authHeader = `Sentry sentry_version=7, sentry_key=${key}, sentry_client=jaiph/${VERSION}`;
  return { endpoint, authHeader };
}

function parseJournal(lines: string[]): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as JournalEvent);
    } catch {
      // A malformed line never blocks the report — telemetry is best-effort.
    }
  }
  return events;
}

/**
 * Map journal lines + run metadata to a Sentry event payload.
 *
 * Pure: `event_id` is the run id UUID with dashes stripped; the failing step is
 * the first `STEP_END` with a nonzero status; its redacted `err_content` (else
 * `out_content`) excerpt becomes `extra.failing_step_detail`. `fingerprint`
 * groups re-occurrences per workflow + failing step.
 */
export function buildSentryEvent(lines: string[], meta: SentryEventMeta): Record<string, unknown> {
  const events = parseJournal(lines);
  const runId = asString(events.find((e) => typeof e.run_id === "string")?.run_id);
  const eventId = runId.replace(/-/g, "");
  const timestamp = asString(events[events.length - 1]?.ts) || asString(events[0]?.ts);
  const wf =
    events.find((e) => e.type === "RUN_START") ?? events.find((e) => e.type === "RUN_END");
  const source = asString(wf?.source);

  // First failed step (nonzero STEP_END status) — the run's proximate failure.
  const failing = events.find(
    (e) => e.type === "STEP_END" && typeof e.status === "number" && e.status !== 0,
  );
  const stepKind = failing ? asString(failing.kind) : "";
  const stepName = failing ? asString(failing.name) : "";
  const detail = failing
    ? asString(failing.err_content).trim() || asString(failing.out_content).trim()
    : "";

  const message = meta.signal
    ? `run ${meta.def} terminated by signal ${meta.signal}`
    : `run ${meta.def} failed (exit ${meta.exitStatus})`;

  const tags: Record<string, string> = { "jaiph.def": meta.def };
  if (source) tags["jaiph.source"] = basename(source);
  if (stepKind) tags["jaiph.step.kind"] = stepKind;
  if (stepName) tags["jaiph.step.name"] = stepName;
  if (meta.principal) tags["jaiph.principal"] = meta.principal;
  if (meta.correlationId) tags["jaiph.correlation_id"] = meta.correlationId;

  const extra: Record<string, string> = {};
  if (detail) extra.failing_step_detail = detail;
  if (meta.runDir) extra.run_dir = meta.runDir;

  const event: Record<string, unknown> = {
    event_id: eventId,
    timestamp,
    platform: "node",
    level: "error",
    message: { formatted: message },
    tags,
    extra,
    fingerprint: ["jaiph", meta.def, stepName || "unknown"],
    release: meta.release,
  };
  if (meta.environment) event.environment = meta.environment;
  return event;
}

/**
 * Frame a Sentry envelope: an envelope header line (`event_id` + `sent_at`), an
 * item header line (`type: event`), and the event JSON — three newline-separated
 * JSON documents.
 */
export function buildEnvelope(event: Record<string, unknown>, sentAt: string): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${body}`;
}

/**
 * Report a failed run to Sentry from the shared post-run hook. No-op on success
 * (only nonzero exit / a signal reports) and when `SENTRY_DSN` is unset. Any
 * transport/HTTP/DSN failure produces exactly one warning through `warn`
 * (default: one stderr line) and nothing else — the run's exit code and output
 * are untouched. Returns the delivery outcome so the caller can track failures
 * as bounded metrics on the long-lived (detached) delivery path.
 *
 * `timeoutMs` bounds the envelope POST; callers pass the shared flush budget so
 * OTLP and Sentry share one total budget when run concurrently.
 */
export async function reportRunFailureToSentry(
  opts: ExportRunTelemetryOptions,
  timeoutMs: number = SEND_TIMEOUT_MS,
  warn: (msg: string) => void = stderrWarn,
): Promise<ExportOutcome> {
  const { runDir, def, exitStatus, signal, env } = opts;

  // Fire only on an unsuccessful terminal state — successful runs send nothing.
  const runFailed = exitStatus !== 0 || signal != null;
  if (!runFailed) return "skipped";

  const dsnRaw = env.SENTRY_DSN?.trim();
  if (!dsnRaw) return "skipped"; // disabled

  const dsn = parseSentryDsn(dsnRaw);
  if (!dsn) {
    warn("jaiph: Sentry error report skipped — malformed SENTRY_DSN\n");
    return "failed";
  }

  if (!runDir) return "skipped";
  const summaryFile = join(runDir, "run_summary.jsonl");
  if (!existsSync(summaryFile)) return "skipped";
  // Hard-fail on a tampered journal (finding H-3): never report a run whose
  // keyed chain does not verify. Unverifiable (unkeyed/legacy) runs pass through.
  const integrity = verifyRunJournal(runDir);
  if (integrity.verified && !integrity.ok) {
    warn(`jaiph: Sentry error report skipped — run journal failed integrity verification (${integrity.error})\n`);
    return "failed";
  }
  let lines: string[];
  try {
    lines = readFileSync(summaryFile, "utf8").split("\n");
  } catch {
    return "skipped";
  }
  if (lines.every((l) => l.trim().length === 0)) return "skipped";

  const release = env.SENTRY_RELEASE?.trim() || `jaiph@${VERSION}`;
  const environment = env.SENTRY_ENVIRONMENT?.trim() || undefined;
  const event = buildSentryEvent(lines, {
    def,
    exitStatus,
    signal,
    runDir,
    release,
    environment,
    principal: opts.identity?.principal,
    correlationId: opts.identity?.correlationId,
  });
  const envelope = buildEnvelope(event, new Date().toISOString());

  try {
    await postWithTimeout(
      dsn.endpoint,
      envelope,
      { "content-type": "application/x-sentry-envelope", "x-sentry-auth": dsn.authHeader },
      timeoutMs,
    );
    return "sent";
  } catch (err) {
    warn(`jaiph: Sentry error report failed — ${errText(err)}\n`);
    return "failed";
  }
}
