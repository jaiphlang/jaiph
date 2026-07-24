/**
 * OTLP/HTTP trace export for a completed run.
 *
 * Export happens host-side, after the run reaches terminal state, by reading the
 * run's `run_summary.jsonl` — never inside the runtime/emitter. The journal is
 * complete (it carries the WORKFLOW and PROMPT records the live stderr stream omits),
 * already credential-redacted, and host-visible in every sandbox mode, so nothing
 * new crosses the container boundary. Telemetry is never load-bearing: an
 * unreachable or erroring collector produces exactly one stderr warning and never
 * affects the run's exit code, output, or journal.
 *
 * Only OTLP/HTTP with a JSON payload (`http/json`) is spoken. Zero runtime
 * dependencies — a `node:https`/`node:http` request is the whole transport.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { VERSION } from "../../version";

/** Metadata the pure mapper needs beyond the journal lines themselves. */
export interface OtlpMeta {
  /** Root workflow symbol (`default` for `jaiph run`, the tool symbol for MCP). */
  workflow: string;
  /** Child exit status; nonzero marks the root span ERROR. */
  exitStatus: number;
  /** Terminating signal, when the run was killed; marks the root span ERROR. */
  signal: string | null;
  /** `service.name` resource attribute (OTEL_SERVICE_NAME, default `jaiph`). */
  serviceName: string;
  /** Extra resource attributes (OTEL_RESOURCE_ATTRIBUTES pairs + `jaiph.version`). */
  resourceAttributes: Record<string, string>;
}

/** One OTLP AnyValue-wrapped attribute. */
interface OtlpAttr {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

type JournalEvent = Record<string, unknown>;

/** SPAN_KIND_INTERNAL. */
const SPAN_KIND_INTERNAL = 1;
/** STATUS_CODE_OK / STATUS_CODE_ERROR. */
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Span id = first 16 hex chars of sha256(<event id>). Deterministic per journal. */
function spanIdFor(eventId: string): string {
  return sha256hex(eventId).slice(0, 16);
}

/** ISO timestamp (`2026-04-21T16:02:18Z`) → nanoseconds-since-epoch string. */
function tsToNano(ts: string | undefined): string {
  if (!ts) return "0";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "0";
  return (BigInt(ms) * 1_000_000n).toString();
}

function strAttr(key: string, value: string): OtlpAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpAttr {
  return { key, value: { intValue: String(value) } };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Map journal lines + run metadata to an OTLP/HTTP JSON `ExportTraceServiceRequest`.
 *
 * Pure: identical input yields byte-identical output, so re-exporting a run
 * produces the same trace/span ids (trace id = run id UUID with dashes stripped;
 * span id = first 16 hex of sha256(event id)).
 */
export function runSummaryToOtlp(lines: string[], meta: OtlpMeta): Record<string, unknown> {
  const events: JournalEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as JournalEvent);
    } catch {
      // A malformed line never blocks the export — telemetry is best-effort.
    }
  }

  const runId =
    asString(events.find((e) => typeof e.run_id === "string")?.run_id) || "";
  const traceId = runId.replace(/-/g, "");
  const rootSpanId = spanIdFor(runId);

  const wfStart = events.find((e) => e.type === "WORKFLOW_START");
  const wfEnd = events.find((e) => e.type === "WORKFLOW_END");
  const firstTs = asString(events[0]?.ts);
  const lastTs = asString(events[events.length - 1]?.ts) || firstTs;
  const rootStart = asString(wfStart?.ts) || firstTs;
  const rootEnd = asString(wfEnd?.ts) || lastTs;
  const source = asString(wfStart?.source) || asString(wfEnd?.source);
  const runFailed = meta.exitStatus !== 0 || meta.signal != null;

  const spans: Record<string, unknown>[] = [];

  // Root span — one per run.
  spans.push({
    traceId,
    spanId: rootSpanId,
    name: `workflow ${meta.workflow}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: tsToNano(rootStart),
    endTimeUnixNano: tsToNano(rootEnd),
    status: runFailed
      ? {
          code: STATUS_CODE_ERROR,
          message: meta.signal ? `terminated by signal ${meta.signal}` : `exit status ${meta.exitStatus}`,
        }
      : { code: STATUS_CODE_OK },
    events: logSpanEvents(events),
  });

  // One span per STEP_START/STEP_END pair, matched by event id.
  const stepEnds = new Map<string, JournalEvent>();
  for (const e of events) {
    if (e.type === "STEP_END" && typeof e.id === "string") stepEnds.set(e.id, e);
  }
  for (const start of events) {
    if (start.type !== "STEP_START" || typeof start.id !== "string") continue;
    const end = stepEnds.get(start.id);
    const parentId = asString(start.parent_id);
    const status = end ? asNumberOrNull(end.status) : null;
    const failed = end ? status != null && status !== 0 : true;
    const attrs: OtlpAttr[] = [
      strAttr("jaiph.step.kind", asString(start.kind)),
      strAttr("jaiph.step.func", asString(start.func)),
      strAttr("jaiph.step.name", asString(start.name)),
      intAttr("jaiph.step.seq", asNumberOrNull(start.seq) ?? 0),
      intAttr("jaiph.step.depth", asNumberOrNull(start.depth) ?? 0),
    ];
    if (status != null) attrs.push(intAttr("jaiph.step.status", status));
    const elapsed = end ? asNumberOrNull(end.elapsed_ms) : null;
    if (elapsed != null) attrs.push(intAttr("jaiph.step.elapsed_ms", elapsed));
    // Redacted-in-journal captures — surfaces step output in the trace without
    // ever touching the raw (unredacted) capture files.
    const outContent = end ? asString(end.out_content) : "";
    if (outContent.length > 0) attrs.push(strAttr("jaiph.step.out", outContent));
    const errContent = end ? asString(end.err_content) : "";
    if (errContent.length > 0) attrs.push(strAttr("jaiph.step.err", errContent));
    spans.push({
      traceId,
      spanId: spanIdFor(start.id),
      parentSpanId: parentId ? spanIdFor(parentId) : rootSpanId,
      name: `${asString(start.kind)} ${asString(start.name)}`.trim(),
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: tsToNano(asString(start.ts)),
      endTimeUnixNano: tsToNano(end ? asString(end.ts) : lastTs),
      status: failed ? { code: STATUS_CODE_ERROR } : { code: STATUS_CODE_OK },
      attributes: attrs,
    });
  }

  // PROMPT_START/PROMPT_END pairs → child spans of their step_id. No `id` field,
  // so pair FIFO per step_id and derive a deterministic span id from the ordinal.
  const openPrompts = new Map<string, Array<{ start: JournalEvent; index: number }>>();
  let promptIndex = 0;
  for (const e of events) {
    if (e.type === "PROMPT_START") {
      const stepId = asString(e.step_id);
      const list = openPrompts.get(stepId) ?? [];
      list.push({ start: e, index: promptIndex });
      openPrompts.set(stepId, list);
      promptIndex += 1;
    } else if (e.type === "PROMPT_END") {
      const stepId = asString(e.step_id);
      const open = openPrompts.get(stepId);
      const match = open?.shift();
      if (match) spans.push(promptSpan(traceId, rootSpanId, match.start, e, match.index, lastTs));
    }
  }
  // Unmatched PROMPT_START (crash mid-prompt) closes at the last event, ERROR.
  for (const list of openPrompts.values()) {
    for (const { start, index } of list) {
      spans.push(promptSpan(traceId, rootSpanId, start, null, index, lastTs));
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(meta, runId, source) },
        scopeSpans: [{ scope: { name: "jaiph", version: VERSION }, spans }],
      },
    ],
  };
}

function promptSpan(
  traceId: string,
  rootSpanId: string,
  start: JournalEvent,
  end: JournalEvent | null,
  index: number,
  lastTs: string,
): Record<string, unknown> {
  const stepId = asString(start.step_id);
  const status = end ? asNumberOrNull(end.status) : null;
  const failed = end ? status != null && status !== 0 : true;
  const attrs: OtlpAttr[] = [strAttr("jaiph.prompt.backend", asString(start.backend))];
  const model = asString(end?.model) || asString(start.model);
  if (model.length > 0) attrs.push(strAttr("jaiph.prompt.model", model));
  if (status != null) attrs.push(intAttr("jaiph.prompt.status", status));
  return {
    traceId,
    spanId: spanIdFor(`prompt:${stepId}:${index}`),
    parentSpanId: stepId ? spanIdFor(stepId) : rootSpanId,
    name: `prompt ${asString(start.backend)}`.trim(),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: tsToNano(asString(start.ts)),
    endTimeUnixNano: tsToNano(end ? asString(end.ts) : lastTs),
    status: failed ? { code: STATUS_CODE_ERROR } : { code: STATUS_CODE_OK },
    attributes: attrs,
  };
}

/** LOGERR/LOGWARN events become span events on the root span. */
function logSpanEvents(events: JournalEvent[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.type !== "LOGERR" && e.type !== "LOGWARN") continue;
    out.push({
      timeUnixNano: tsToNano(asString(e.ts)),
      name: "log",
      attributes: [strAttr("level", asString(e.type)), strAttr("message", asString(e.message))],
    });
  }
  return out;
}

function resourceAttributes(meta: OtlpMeta, runId: string, source: string): OtlpAttr[] {
  const merged: Record<string, string> = {
    "service.name": meta.serviceName,
    ...meta.resourceAttributes,
    "jaiph.run_id": runId,
    "jaiph.workflow": meta.workflow,
    "jaiph.source": source,
  };
  return Object.entries(merged).map(([k, v]) => strAttr(k, v));
}

/**
 * Resolve the OTLP traces endpoint from standard OTEL env. The traces-specific
 * endpoint is used verbatim; the generic endpoint is a base URL with `/v1/traces`
 * appended. Traces-specific wins when both are set. Returns undefined (export
 * disabled) when neither is set.
 */
export function resolveOtlpEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traces) return traces;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (base) return `${base.replace(/\/+$/, "")}/v1/traces`;
  return undefined;
}

/** Parse a comma-separated `k=v` list (OTEL_EXPORTER_OTLP_HEADERS / _RESOURCE_ATTRIBUTES). */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p.length === 0) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** POST the payload as JSON with a 10 s timeout. Rejects on non-2xx / transport error. */
function postOtlp(
  endpoint: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      reject(new Error(`invalid endpoint ${endpoint}`));
      return;
    }
    const body = JSON.stringify(payload);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) resolve();
          else reject(new Error(`collector returned HTTP ${code}`));
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("timed out after 10s")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Options for the shared post-run export hook. */
export interface ExportRunTelemetryOptions {
  /** Absolute host run directory; its `run_summary.jsonl` is the export source. */
  runDir?: string;
  workflow: string;
  exitStatus: number;
  signal: string | null;
  env: NodeJS.ProcessEnv;
}

/**
 * Single shared post-run hook, invoked wherever a run reaches terminal state on
 * the host (`jaiph run` completion, the shared workflow-call layer). Enabled iff
 * an OTLP traces endpoint is configured. Best-effort: any failure produces one
 * stderr warning and nothing else.
 */
export async function exportRunTelemetry(opts: ExportRunTelemetryOptions): Promise<void> {
  const { runDir, workflow, exitStatus, signal, env } = opts;
  const endpoint = resolveOtlpEndpoint(env);
  if (!endpoint) return;

  const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim();
  if (protocol && protocol !== "http/json") {
    process.stderr.write(
      `jaiph: OTLP trace export skipped — unsupported OTEL_EXPORTER_OTLP_PROTOCOL "${protocol}" (only http/json is supported)\n`,
    );
    return;
  }

  if (!runDir) return;
  const summaryFile = join(runDir, "run_summary.jsonl");
  if (!existsSync(summaryFile)) return;
  let lines: string[];
  try {
    lines = readFileSync(summaryFile, "utf8").split("\n");
  } catch {
    return;
  }
  if (lines.every((l) => l.trim().length === 0)) return;

  const serviceName = env.OTEL_SERVICE_NAME?.trim() || "jaiph";
  const resourceAttrs = {
    ...parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES),
    "jaiph.version": VERSION,
  };
  const payload = runSummaryToOtlp(lines, { workflow, exitStatus, signal, serviceName, resourceAttributes: resourceAttrs });
  const headers = parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS);

  try {
    await postOtlp(endpoint, payload, headers);
  } catch (err) {
    process.stderr.write(
      `jaiph: OTLP trace export failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
