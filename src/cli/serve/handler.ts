import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpToolSpec } from "../mcp/tools";
import type { WorkflowCallResult, WorkflowCallContext } from "../exec/call";
import { buildOpenApi } from "./openapi";
import { DOCS_HTML } from "./docs";

/** 1 MiB cap on request bodies (design doc). */
export const MAX_BODY_BYTES = 1024 * 1024;

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
  /** Current-time source (ISO string), injectable for tests. */
  now: () => string;
  /** Run-id source, injectable for tests. Defaults to `randomUUID`. */
  newRunId?: () => string;
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

  constructor(opts: ServeHandlerOptions) {
    this.opts = opts;
    this.newRunId = opts.newRunId ?? randomUUID;
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

    // Everything under /v1 is bearer-protected (when a token is configured).
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
      const runs = [...this.runs.values()]
        .sort((a, b) => b.order - a.order)
        .map((r) => this.toRunObject(r));
      return this.json(200, { runs });
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

    if (this.inFlight() >= this.opts.maxConcurrent) {
      return this.error(429, "E_TOO_MANY_RUNS", `too many concurrent runs (max ${this.opts.maxConcurrent})`);
    }

    const args: Record<string, string> = {};
    for (const p of spec.params) args[p] = raw[p] as string;

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
      onCancelHandle: (cancelFn) => {
        record.cancel = cancelFn;
        // A cancel may arrive before the child spawns; honor it now.
        if (record.cancelled) cancelFn();
      },
    };
    const done = this.opts
      .callTool(spec, args, runId, ctx)
      .then((result) => this.finalize(record, result))
      .catch((err) => this.finalizeError(record, err));

    const wait = req.query.get("wait") === "true";
    if (wait) {
      await done;
      return this.json(200, this.toRunObject(record));
    }
    return {
      status: 202,
      headers: { "content-type": "application/json", location: `/v1/runs/${runId}` },
      body: JSON.stringify(this.toRunObject(record)),
    };
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

  private finalize(record: RunRecord, result: WorkflowCallResult): void {
    record.ended_at = this.opts.now();
    record.exit_status = result.exitStatus ?? null;
    record.signal = result.signal ?? null;
    record.result_text = result.text;
    record.run_dir = result.runDir ?? null;
    record.status = record.cancelled ? "cancelled" : result.isError ? "failed" : "succeeded";
  }

  private finalizeError(record: RunRecord, err: unknown): void {
    record.ended_at = this.opts.now();
    record.result_text = err instanceof Error ? err.message : String(err);
    record.status = record.cancelled ? "cancelled" : "failed";
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

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.split(";")[0].trim().toLowerCase() === "application/json";
}
