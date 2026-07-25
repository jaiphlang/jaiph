import { randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { McpToolSpec } from "../mcp/tools";
import { McpServer, type McpCallContext } from "../mcp/server";
import type { WorkflowCallResult, WorkflowCallContext } from "../exec/call";
import { buildOpenApi } from "./openapi";
import { DOCS_HTML } from "./docs";
import {
  listArtifacts,
  resolveArtifactPath,
  streamRunEventsSse,
  RUN_SUMMARY,
  type StreamTarget,
} from "./runfiles";

/** 1 MiB cap on request bodies (design doc). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Default page size for `GET /v1/runs` when the caller gives no `limit`. */
export const DEFAULT_RUNS_PAGE = 100;
/** Hard maximum page size for `GET /v1/runs` — a `limit` above this is clamped. */
export const MAX_RUNS_PAGE = 1000;

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** In-memory record for one run: the public run object plus cancel bookkeeping. */
export interface RunRecord {
  run_id: string;
  workflow: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  exit_status: number | null;
  signal: string | null;
  result_text: string | null;
  run_dir: string | null;
  /** Set once a cancel is requested, so terminal status resolves to `cancelled`. */
  cancelled: boolean;
  /** Child terminator registered by the executor; kills the run + container. */
  cancel?: () => void;
  /** Monotonic insertion index for newest-first listing. */
  order: number;
  /**
   * Cached result of the injected `resolveRunDir` scan for a still-running run,
   * so a live SSE poll loop resolves the runs tree at most once. Never part of
   * the public run object; `run_dir` (set at finalize) takes precedence.
   */
  resolvedRunDir?: string;
}

/** A normalized inbound request — decoupled from `node:http` so it is unit-testable. */
export interface ServeRequest {
  method: string;
  /** Pathname without the query string. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Decoded request body (empty string when none). */
  body: string;
  /** True when the HTTP layer aborted reading past `MAX_BODY_BYTES`. */
  bodyTooLarge?: boolean;
}

/** A normalized response the HTTP layer writes back. */
export interface ServeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /**
   * Absolute path + byte count of a file to stream as the body (artifact
   * download / NDJSON journal). The HTTP layer pipes exactly `size` bytes with
   * backpressure and never buffers the whole file; takes precedence over
   * `body`.
   */
  bodyFile?: { path: string; size: number };
  /**
   * When set, the HTTP layer streams the body by driving this function instead
   * of writing `body` — used for the SSE event follow. It resolves when the
   * stream is complete (run terminal or client gone); the layer then ends the
   * response.
   */
  stream?: (target: StreamTarget) => Promise<void>;
}

export interface ServeHandlerOptions {
  version: string;
  /** `info.title` for the generated OpenAPI document. */
  serverTitle: string;
  /** Current tool list (re-read per request so hot reload just works). */
  getTools: () => McpToolSpec[];
  /** Execute one workflow. The caller supplies `runId`; `ctx` carries cancel. */
  callTool: (
    spec: McpToolSpec,
    args: Record<string, string>,
    runId: string,
    ctx: WorkflowCallContext,
  ) => Promise<WorkflowCallResult>;
  /** Bearer token; when set, every `/v1/*` request must present it. */
  token?: string;
  /** Cap on simultaneously-running workflows (429 beyond it). */
  maxConcurrent: number;
  /**
   * Max completed (terminal) runs kept in the in-memory registry. When the
   * terminal count exceeds this, the oldest terminal records are evicted first.
   * Active (`running`) runs are never evicted. `0` disables count eviction.
   * Eviction only drops the in-memory record; the durable `run_summary.jsonl`
   * and `artifacts/` on disk are untouched (their retention is the operator's).
   */
  retainRuns?: number;
  /**
   * Max age in seconds of a completed run's `ended_at` before it is evicted
   * from the in-memory registry. `0` disables age eviction. Same disk caveat
   * as {@link retainRuns}.
   */
  retainAgeSec?: number;
  /** Current-time source (ISO string), injectable for tests. */
  now: () => string;
  /** Diagnostic line (stderr) for the embedded MCP endpoint. Defaults to a no-op. */
  log?: (line: string) => void;
  /** Run-id source, injectable for tests. Defaults to `randomUUID`. */
  newRunId?: () => string;
  /**
   * Resolve a still-running run's host-side run directory (the one holding
   * `run_summary.jsonl` and `artifacts/`). Consulted by the events/artifacts
   * endpoints only while the record's own `run_dir` (populated at finalize) is
   * absent, and the first non-null result is cached on the record — so one
   * live SSE connection scans the runs tree at most once, no matter how many
   * times it polls. The server supplies a resolver that scans the runs root by
   * run id.
   */
  resolveRunDir?: (record: RunRecord) => string | null;
  /** SSE journal-follow poll interval (ms). Defaults to 250. */
  ssePollMs?: number;
  /** SSE keep-alive comment cadence (ms). Defaults to 15000. */
  sseKeepAliveMs?: number;
  /**
   * Max size in bytes of one artifact download; a larger file is refused with
   * 413. `0` (the default) serves any size — downloads stream with
   * backpressure, so size never translates into server memory.
   */
  maxArtifactBytes?: number;
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * HTTP request router for `jaiph serve`. A pure request-in / response-out state
 * machine over an injected execution layer + run registry (the `McpServer`
 * pattern), so the whole surface — auth, arg validation, error shapes, wait
 * semantics, cancel, the concurrency cap, and generated OpenAPI — is unit
 * testable without opening a socket. The `node:http` glue (`server.ts`) only
 * reads the body and streams this response back.
 */
export class ServeHandler {
  private readonly opts: ServeHandlerOptions;
  private readonly newRunId: () => string;
  /** In-memory run registry, keyed by run id. Public so tests can inspect it. */
  readonly runs = new Map<string, RunRecord>();
  private orderCounter = 0;
  /**
   * MCP protocol engine for the `POST /mcp` Streamable HTTP endpoint. Reuses the
   * exact stdio state machine (`jaiph mcp`); its `tools/call` funnels into the
   * same {@link startRun} the REST endpoint uses, so an MCP call registers in
   * the same run registry, counts against the same concurrency cap, and obeys
   * the same cancellation rules. Per-request outbound routing is handled by
   * `handleLine(line, write)`.
   */
  private readonly mcp: McpServer;

  constructor(opts: ServeHandlerOptions) {
    this.opts = opts;
    this.newRunId = opts.newRunId ?? randomUUID;
    this.mcp = new McpServer({
      serverVersion: opts.version,
      getTools: opts.getTools,
      callTool: (spec, args, ctx) => this.callToolAsRun(spec, args, ctx),
      // Server-initiated broadcasts have no HTTP sink without a GET stream (not
      // offered); every real reply is routed per-request via handleLine(write).
      write: () => {},
      log: opts.log ?? ((): void => {}),
    });
  }

  /**
   * Bridge an MCP `tools/call` into the shared run path. Registers a run
   * (respecting the concurrency cap), forwards MCP progress/cancel hooks, waits
   * for it to finish, then reports the finalized record as an MCP result. At
   * capacity the call comes back as a normal `isError` result — the MCP analogue
   * of the REST `429`, not a protocol error.
   */
  private async callToolAsRun(
    spec: McpToolSpec,
    args: Record<string, string>,
    ctx: McpCallContext,
  ): Promise<{ text: string; isError: boolean }> {
    const started = this.startRun(spec, args, { onStep: ctx.onStep, onCancelHandle: ctx.onCancelHandle });
    if ("atCapacity" in started) {
      return { text: `too many concurrent runs (max ${this.opts.maxConcurrent})`, isError: true };
    }
    await started.done;
    const r = started.record;
    return { text: r.result_text ?? "", isError: r.status !== "succeeded" };
  }

  /**
   * Register and launch one run through the injected executor, shared by the
   * REST create-run endpoint and the MCP `tools/call` bridge. Enforces the
   * concurrency cap up front (returns `{ atCapacity: true }` so each caller maps
   * its own error shape), records the run so it is inspectable and cancellable,
   * and finalizes it when the executor settles. `done` never rejects.
   */
  private startRun(
    spec: McpToolSpec,
    args: Record<string, string>,
    extra?: WorkflowCallContext,
  ): { record: RunRecord; done: Promise<void> } | { atCapacity: true } {
    if (this.inFlight() >= this.opts.maxConcurrent) return { atCapacity: true };
    const runId = this.newRunId();
    const record: RunRecord = {
      run_id: runId,
      workflow: spec.workflow,
      status: "running",
      started_at: this.opts.now(),
      ended_at: null,
      exit_status: null,
      signal: null,
      result_text: null,
      run_dir: null,
      cancelled: false,
      order: this.orderCounter++,
    };
    this.runs.set(runId, record);
    const ctx: WorkflowCallContext = {
      onStep: extra?.onStep,
      onCancelHandle: (cancelFn) => {
        // Wrap so every cancel path (REST /v1/.../cancel, MCP
        // notifications/cancelled, SSE hangup, cancelAll) marks the shared
        // record before killing the child — otherwise an MCP-only cancel
        // would finalize as `failed` instead of `cancelled`.
        const cancel = (): void => {
          record.cancelled = true;
          cancelFn();
        };
        record.cancel = cancel;
        // A cancel may arrive before the child spawns; honor it now.
        if (record.cancelled) cancel();
        extra?.onCancelHandle?.(cancel);
      },
    };
    const done = this.opts
      .callTool(spec, args, runId, ctx)
      .then((result) => this.finalize(record, result))
      .catch((err) => this.finalizeError(record, err));
    return { record, done };
  }

  /** Number of runs still executing (drives the concurrency cap + healthz). */
  inFlight(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === "running") n += 1;
    return n;
  }

  /** Cancel every still-running run (second-signal shutdown: child + container teardown). */
  cancelAll(): void {
    for (const record of this.runs.values()) {
      if (record.status === "running") {
        record.cancelled = true;
        record.cancel?.();
      }
    }
  }

  async handleRequest(req: ServeRequest): Promise<ServeResponse> {
    const { method, path } = req;

    if (path === "/" && method === "GET") {
      return { status: 302, headers: { location: "/docs" }, body: "" };
    }
    if (path === "/healthz") {
      if (method !== "GET") return this.methodNotAllowed();
      return this.json(200, {
        status: "ok",
        version: this.opts.version,
        tools: this.opts.getTools().length,
        in_flight: this.inFlight(),
      });
    }
    if (path === "/openapi.json") {
      if (method !== "GET") return this.methodNotAllowed();
      return this.json(200, buildOpenApi(this.opts.getTools(), { title: this.opts.serverTitle, version: this.opts.version }));
    }
    if (path === "/docs") {
      if (method !== "GET") return this.methodNotAllowed();
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: DOCS_HTML };
    }

    // The MCP Streamable HTTP endpoint and everything under /v1 are the two
    // bearer-protected surfaces (when a token is configured); the same auth
    // boundary guards both transports.
    if (path === "/mcp") {
      if (!this.authorized(req)) {
        return this.error(401, "E_UNAUTHORIZED", "missing or invalid bearer token");
      }
      return this.handleMcp(req);
    }
    if (path === "/v1" || path.startsWith("/v1/")) {
      if (!this.authorized(req)) {
        return this.error(401, "E_UNAUTHORIZED", "missing or invalid bearer token");
      }
      return this.handleV1(req);
    }

    return this.error(404, "E_NOT_FOUND", `not found: ${path}`);
  }

  private handleV1(req: ServeRequest): ServeResponse | Promise<ServeResponse> {
    const { method, path } = req;

    if (path === "/v1/workflows") {
      if (method !== "GET") return this.methodNotAllowed();
      const workflows = this.opts.getTools().map((t) => ({ name: t.name, description: t.description, params: t.params }));
      return this.json(200, { workflows });
    }

    const runPost = /^\/v1\/workflows\/([^/]+)\/runs$/.exec(path);
    if (runPost) {
      if (method !== "POST") return this.methodNotAllowed();
      return this.createRun(req, decodeURIComponent(runPost[1]));
    }

    if (path === "/v1/runs") {
      if (method !== "GET") return this.methodNotAllowed();
      return this.listRuns(req);
    }

    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
    if (events) {
      if (method !== "GET") return this.methodNotAllowed();
      return this.runEvents(req, decodeURIComponent(events[1]));
    }

    const artifactsList = /^\/v1\/runs\/([^/]+)\/artifacts$/.exec(path);
    if (artifactsList) {
      if (method !== "GET") return this.methodNotAllowed();
      return this.listRunArtifacts(decodeURIComponent(artifactsList[1]));
    }

    const artifactGet = /^\/v1\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path);
    if (artifactGet) {
      if (method !== "GET") return this.methodNotAllowed();
      return this.downloadArtifact(decodeURIComponent(artifactGet[1]), artifactGet[2]);
    }

    const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      if (method !== "POST") return this.methodNotAllowed();
      return this.cancelRun(decodeURIComponent(cancel[1]));
    }

    const getRun = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (getRun) {
      if (method !== "GET") return this.methodNotAllowed();
      const record = this.runs.get(decodeURIComponent(getRun[1]));
      if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
      return this.json(200, this.toRunObject(record));
    }

    return this.error(404, "E_NOT_FOUND", `not found: ${path}`);
  }

  private async createRun(req: ServeRequest, name: string): Promise<ServeResponse> {
    const spec = this.opts.getTools().find((t) => t.name === name);
    if (!spec) return this.error(404, "E_NOT_FOUND", `unknown workflow: ${name}`);

    if (req.bodyTooLarge) {
      return this.error(413, "E_BODY_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const hasBody = req.body.length > 0;
    if (hasBody && !isJsonContentType(req.headers["content-type"])) {
      return this.error(415, "E_UNSUPPORTED_MEDIA_TYPE", "request body must be application/json");
    }
    let raw: Record<string, unknown>;
    if (hasBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body);
      } catch {
        return this.error(400, "E_BAD_ARGS", "request body is not valid JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return this.error(400, "E_BAD_ARGS", "request body must be a JSON object of parameters");
      }
      raw = parsed as Record<string, unknown>;
    } else {
      raw = {};
    }

    // Param validation mirrors the MCP `-32602` rules (missing / non-string /
    // unexpected key) as HTTP 400.
    const missing = spec.params.filter((p) => typeof raw[p] !== "string");
    if (missing.length > 0) {
      return this.error(400, "E_BAD_ARGS", `missing or non-string argument(s) for "${spec.name}": ${missing.join(", ")}`);
    }
    const unexpected = Object.keys(raw).filter((k) => !spec.params.includes(k));
    if (unexpected.length > 0) {
      return this.error(400, "E_BAD_ARGS", `unexpected argument(s) for "${spec.name}": ${unexpected.join(", ")}`);
    }

    const args: Record<string, string> = {};
    for (const p of spec.params) args[p] = raw[p] as string;

    const started = this.startRun(spec, args);
    if ("atCapacity" in started) {
      return this.error(429, "E_TOO_MANY_RUNS", `too many concurrent runs (max ${this.opts.maxConcurrent})`);
    }
    const { record, done } = started;

    const wait = req.query.get("wait") === "true";
    if (wait) {
      await done;
      return this.json(200, this.toRunObject(record));
    }
    return {
      status: 202,
      headers: { "content-type": "application/json", location: `/v1/runs/${record.run_id}` },
      body: JSON.stringify(this.toRunObject(record)),
    };
  }

  /**
   * `POST /mcp`: MCP Streamable HTTP. One JSON-RPC message per request, handled
   * by the shared {@link mcp} engine — so `tools/call` runs the exact same
   * workflow generation, sandbox posture, run registry, concurrency cap, and
   * cancellation as the REST API.
   *
   * Response shape: a message carrying no reply (a notification such as
   * `notifications/cancelled`, or a `notifications/initialized`) settles as
   * `202 Accepted` with no body. A request gets its reply either as a single
   * `application/json` object or, when the client offers `text/event-stream`
   * for a `tools/call`, as an SSE stream carrying `notifications/progress` and
   * then the result. A GET/DELETE gets `405` (no server-initiated stream is
   * offered here), matching the transport spec.
   */
  private async handleMcp(req: ServeRequest): Promise<ServeResponse> {
    if (req.method !== "POST") {
      return {
        status: 405,
        headers: { allow: "POST", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "use POST for MCP Streamable HTTP" },
        }),
      };
    }
    if (req.bodyTooLarge) {
      return this.error(413, "E_BODY_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }

    const parsed = safeJsonObject(req.body);
    const requestId = parsed && "id" in parsed && "method" in parsed ? parsed.id : undefined;
    const method = parsed && typeof parsed.method === "string" ? parsed.method : undefined;
    const wantsSse = (req.headers["accept"] ?? "").includes("text/event-stream");

    // A tools/call may emit progress; stream it as SSE when the client offers
    // that content type. The client hanging up cancels the run through the same
    // MCP cancel path (kills the child + Docker container).
    if (requestId !== undefined && method === "tools/call" && wantsSse) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        body: "",
        stream: (target) => {
          target.onAbort(() => {
            void this.mcp.handleLine(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } }),
            );
          });
          return this.mcp.handleLine(req.body, (m) => {
            if (!target.aborted) target.write(`data: ${JSON.stringify(m)}\n\n`);
          });
        },
      };
    }

    // JSON mode: buffer this message's outbound traffic and return the reply.
    const collected: Record<string, unknown>[] = [];
    await this.mcp.handleLine(req.body, (m) => collected.push(m));
    // A pure notification produces nothing to return.
    if (collected.length === 0) return { status: 202, headers: {}, body: "" };
    const reply = collected.find((m) => "id" in m) ?? collected[collected.length - 1];
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(reply) };
  }

  /**
   * `GET /v1/runs`: newest-first page of runs. `limit` defaults to
   * {@link DEFAULT_RUNS_PAGE} and is clamped to `[1, MAX_RUNS_PAGE]`; `offset`
   * defaults to 0 (clamped to `>= 0`). The response can never be unbounded —
   * at most `MAX_RUNS_PAGE` records regardless of the query. Order is stable:
   * the monotonic `order` field is unique and never reused, so paging is
   * deterministic across requests as long as no new run is inserted between
   * them. `total` is the full registry size so a client can page through it.
   */
  private listRuns(req: ServeRequest): ServeResponse {
    const limit = clampInt(req.query.get("limit"), DEFAULT_RUNS_PAGE, 1, MAX_RUNS_PAGE);
    const offset = clampInt(req.query.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sorted = [...this.runs.values()].sort((a, b) => b.order - a.order);
    const runs = sorted.slice(offset, offset + limit).map((r) => this.toRunObject(r));
    return this.json(200, { runs, total: sorted.length, limit, offset });
  }

  /**
   * Drop terminal records past the retention limits so the registry cannot grow
   * without bound over a long-lived server. Active runs are never touched, and
   * only the in-memory record is removed — the durable journal and artifacts on
   * disk are the operator's to prune. Called after every run finalizes.
   */
  private evictCompleted(): void {
    const ageSec = this.opts.retainAgeSec ?? 0;
    if (ageSec > 0) {
      const cutoff = Date.parse(this.opts.now()) - ageSec * 1000;
      for (const r of this.runs.values()) {
        if (!isTerminal(r.status) || !r.ended_at) continue;
        const ended = Date.parse(r.ended_at);
        if (Number.isFinite(ended) && ended < cutoff) this.runs.delete(r.run_id);
      }
    }
    const max = this.opts.retainRuns ?? 0;
    if (max > 0) {
      // Oldest terminal records first (ascending `order`); keep the newest `max`.
      const terminal = [...this.runs.values()].filter((r) => isTerminal(r.status)).sort((a, b) => a.order - b.order);
      for (let i = 0; i < terminal.length - max; i += 1) this.runs.delete(terminal[i].run_id);
    }
  }

  private cancelRun(id: string): ServeResponse {
    const record = this.runs.get(id);
    if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
    if (isTerminal(record.status)) {
      return this.error(409, "E_RUN_TERMINAL", `run is already ${record.status}`);
    }
    record.cancelled = true;
    record.cancel?.();
    return { status: 202, headers: { "content-type": "application/json" }, body: JSON.stringify(this.toRunObject(record)) };
  }

  /**
   * Host-side run dir for a record: its own `run_dir` (set at finalize), else
   * the cached mid-run resolution, else one injected-resolver scan whose hit is
   * cached on the record — repeated polls never rescan the runs tree.
   */
  private runDirFor(record: RunRecord): string | null {
    if (record.run_dir) return record.run_dir;
    if (record.resolvedRunDir) return record.resolvedRunDir;
    const dir = this.opts.resolveRunDir ? this.opts.resolveRunDir(record) : null;
    if (dir) record.resolvedRunDir = dir;
    return dir;
  }

  /**
   * `GET /v1/runs/{id}/events`. Default: the run's `run_summary.jsonl` as
   * `application/x-ndjson`, streamed verbatim (never buffered whole), then
   * close. `Accept: text/event-stream`: SSE replay + live follow until the run
   * is terminal. The journal's own redaction is the redaction guarantee; raw
   * capture files are never served.
   */
  private runEvents(req: ServeRequest, id: string): ServeResponse {
    const record = this.runs.get(id);
    if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
    const wantsSse = (req.headers["accept"] ?? "").includes("text/event-stream");
    const resolveRunDir = (): string | null => this.runDirFor(record);
    if (!wantsSse) {
      const dir = resolveRunDir();
      const file = dir ? join(dir, RUN_SUMMARY) : null;
      let size = 0;
      if (file) {
        try {
          size = statSync(file).size;
        } catch {
          size = 0; // Absent journal serves as an empty body.
        }
      }
      return {
        status: 200,
        headers: { "content-type": "application/x-ndjson", "content-length": String(size) },
        body: "",
        bodyFile: file && size > 0 ? { path: file, size } : undefined,
      };
    }
    return {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: "",
      stream: (target) =>
        streamRunEventsSse(target, {
          resolveRunDir,
          isTerminal: () => isTerminal(record.status),
          pollMs: this.opts.ssePollMs ?? 250,
          keepAliveMs: this.opts.sseKeepAliveMs ?? 15000,
        }),
    };
  }

  /** `GET /v1/runs/{id}/artifacts`: JSON list of published files (empty when none). */
  private listRunArtifacts(id: string): ServeResponse {
    const record = this.runs.get(id);
    if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
    const dir = this.runDirFor(record);
    return this.json(200, { artifacts: dir ? listArtifacts(dir) : [] });
  }

  /**
   * `GET /v1/runs/{id}/artifacts/{path}`: download one published file as
   * `application/octet-stream`, streamed with backpressure — the complete
   * artifact is never buffered, so an arbitrarily large file costs no server
   * memory. `maxArtifactBytes > 0` refuses larger files with 413.
   * Traversal-proof — anything escaping the run's `artifacts/` dir (`..`,
   * absolute paths, escaping symlinks) is a 404, and raw `%06d-*.out`/`.err`
   * capture files (run-dir root, not `artifacts/`) are unreachable by
   * construction.
   */
  private downloadArtifact(id: string, rawPath: string): ServeResponse {
    const record = this.runs.get(id);
    if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
    const dir = this.runDirFor(record);
    if (!dir) return this.error(404, "E_NOT_FOUND", "unknown artifact");
    let requested: string;
    try {
      requested = decodeURIComponent(rawPath);
    } catch {
      return this.error(404, "E_NOT_FOUND", "unknown artifact");
    }
    const abs = resolveArtifactPath(dir, requested);
    if (!abs) return this.error(404, "E_NOT_FOUND", "unknown artifact");
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return this.error(404, "E_NOT_FOUND", "unknown artifact");
    }
    const maxBytes = this.opts.maxArtifactBytes ?? 0;
    if (maxBytes > 0 && size > maxBytes) {
      return this.error(
        413,
        "E_ARTIFACT_TOO_LARGE",
        `artifact is ${size} bytes; downloads are capped at ${maxBytes} (JAIPH_SERVE_MAX_ARTIFACT_BYTES)`,
      );
    }
    const filename = basename(abs).replace(/"/g, "");
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(size),
      },
      body: "",
      bodyFile: { path: abs, size },
    };
  }

  private finalize(record: RunRecord, result: WorkflowCallResult): void {
    record.ended_at = this.opts.now();
    record.exit_status = result.exitStatus ?? null;
    record.signal = result.signal ?? null;
    record.result_text = result.text;
    record.run_dir = result.runDir ?? null;
    record.status = record.cancelled ? "cancelled" : result.isError ? "failed" : "succeeded";
    this.evictCompleted();
  }

  private finalizeError(record: RunRecord, err: unknown): void {
    record.ended_at = this.opts.now();
    record.result_text = err instanceof Error ? err.message : String(err);
    record.status = record.cancelled ? "cancelled" : "failed";
    this.evictCompleted();
  }

  private authorized(req: ServeRequest): boolean {
    if (!this.opts.token) return true;
    const header = req.headers["authorization"];
    if (!header) return false;
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(this.opts.token);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private toRunObject(r: RunRecord): Record<string, unknown> {
    return {
      run_id: r.run_id,
      workflow: r.workflow,
      status: r.status,
      started_at: r.started_at,
      ended_at: r.ended_at,
      exit_status: r.exit_status,
      signal: r.signal,
      result_text: r.result_text,
      run_dir: r.run_dir,
    };
  }

  private json(status: number, obj: unknown): ServeResponse {
    return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
  }

  private error(status: number, code: string, message: string): ServeResponse {
    return { status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code, message } }) };
  }

  private methodNotAllowed(): ServeResponse {
    return this.error(405, "E_METHOD_NOT_ALLOWED", "method not allowed");
  }
}

/** Parse a JSON object, returning null for non-objects or malformed input. */
function safeJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Parse a query param as an integer, clamped to `[min, max]`. A missing or
 * malformed value falls back to `fallback` (itself already within range), so a
 * hostile `?limit=` can never widen the page beyond `max`.
 */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
