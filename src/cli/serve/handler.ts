import { randomUUID } from "node:crypto";
import { errText } from "../../errors";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { hashArgs } from "./run-store";
import { createAuthenticator, openPrincipal, type Authenticator, type Capability, type Principal } from "./auth";
import { safeJsonObject, isJsonContentType, clampInt } from "./http-util";
import type { RunStatus, RunRecord, ServeRequest, ServeResponse, ServeHandlerOptions } from "./types";

export type { RunStatus, RunRecord, ServeRequest, ServeResponse, ServeHandlerOptions } from "./types";

/** 1 MiB cap on request bodies (design doc). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Default page size for `GET /v1/runs` when the caller gives no `limit`. */
export const DEFAULT_RUNS_PAGE = 100;
/** Hard maximum page size for `GET /v1/runs` — a `limit` above this is clamped. */
export const MAX_RUNS_PAGE = 1000;

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
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
   * Composite idempotency key (`principal\nworkflow\nkey`) → run id. Reserved
   * synchronously at create time and consulted before spawning, so a repeated
   * create with the same key returns the original run instead of starting a
   * duplicate. Rebuilt from reconstructed records at startup; entries are
   * dropped when their run is evicted.
   */
  private readonly idempotencyIndex = new Map<string, string>();
  /**
   * MCP protocol engine for the `POST /mcp` Streamable HTTP endpoint. Reuses the
   * exact stdio state machine (`jaiph mcp`); its `tools/call` funnels into the
   * same {@link startRun} the REST endpoint uses, so an MCP call registers in
   * the same run registry, counts against the same concurrency cap, and obeys
   * the same cancellation rules. Per-request outbound routing is handled by
   * `handleLine(line, write)`.
   */
  private readonly mcp: McpServer;
  /** Authentication/authorization engine (static/oidc/open). */
  private readonly auth: Authenticator;
  /** Whether `/docs` and `/openapi.json` are exposed. */
  private readonly exposeDocs: boolean;
  /**
   * The authenticated principal + correlation id of the request in flight,
   * propagated across every async step (including the MCP engine's `tools/call`
   * dispatch) so capability checks, run ownership, audit logging, and telemetry
   * identity all read one consistent identity without threading it as a param
   * through every method. Absent only outside a request (defaults to open).
   */
  private readonly reqCtx = new AsyncLocalStorage<{ principal: Principal; correlationId: string }>();

  constructor(opts: ServeHandlerOptions) {
    this.opts = opts;
    this.newRunId = opts.newRunId ?? randomUUID;
    this.auth = opts.authenticator ?? createAuthenticator({ token: opts.token });
    this.exposeDocs = opts.exposeDocs ?? true;
    this.mcp = new McpServer({
      serverVersion: opts.version,
      getTools: opts.getTools,
      callTool: (spec, args, ctx) => this.callToolAsRun(spec, args, ctx),
      // Server-initiated broadcasts have no HTTP sink without a GET stream (not
      // offered); every real reply is routed per-request via handleLine(write).
      write: () => {},
      log: opts.log ?? ((): void => {}),
    });
    // Seed the registry from durable state so a restart does not lose run ids.
    for (const record of opts.initialRuns ?? []) {
      record.order = this.orderCounter++;
      this.runs.set(record.run_id, record);
      if (record.idempotency_key) this.idempotencyIndex.set(record.idempotency_key, record.run_id);
    }
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
    const { principal } = this.currentCtx();
    if (!principal.capabilities.has("invoke")) {
      return { text: `not authorized: the principal lacks the "invoke" capability`, isError: true };
    }
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
    const { principal, correlationId } = this.currentCtx();
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
      // Attach the authenticated identity at create time: this is the run's
      // owner (inspect/cancel scope), audit subject, and idempotency scope.
      principal: principal.subject,
      correlation_id: correlationId || undefined,
    };
    this.runs.set(runId, record);
    this.opts.log?.(
      `jaiph serve: run ${runId} invoked — principal=${principal.subject} correlation=${correlationId || "-"} workflow=${spec.workflow}`,
    );
    const ctx: WorkflowCallContext = {
      onStep: extra?.onStep,
      // Identity for the detached telemetry export (OTLP resource attrs + Sentry
      // tags). Never a token — only the audit subject and correlation id.
      principal: principal.subject,
      correlationId: correlationId || undefined,
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
      if (!this.exposeDocs) return this.error(404, "E_NOT_FOUND", `not found: ${path}`);
      return this.json(200, buildOpenApi(this.opts.getTools(), { title: this.opts.serverTitle, version: this.opts.version }));
    }
    if (path === "/docs") {
      if (method !== "GET") return this.methodNotAllowed();
      if (!this.exposeDocs) return this.error(404, "E_NOT_FOUND", `not found: ${path}`);
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: DOCS_HTML };
    }

    // The MCP Streamable HTTP endpoint and everything under /v1 share one
    // authentication boundary. A verified request carries a Principal
    // (capabilities + ownership) + correlation id through an AsyncLocalStorage,
    // so authorization, ownership, audit, and telemetry read one identity
    // consistently across both transports.
    if (path === "/mcp") {
      const auth = await this.auth.authenticate(req.headers["authorization"]);
      if (!auth.ok) return this.error(auth.status, auth.code, auth.message);
      return this.reqCtx.run({ principal: auth.principal, correlationId: this.correlationOf(req) }, () => this.handleMcp(req));
    }
    if (path === "/v1" || path.startsWith("/v1/")) {
      const auth = await this.auth.authenticate(req.headers["authorization"]);
      if (!auth.ok) return this.error(auth.status, auth.code, auth.message);
      return this.reqCtx.run({ principal: auth.principal, correlationId: this.correlationOf(req) }, () => this.handleV1(req));
    }

    return this.error(404, "E_NOT_FOUND", `not found: ${path}`);
  }

  /** Identity of the request in flight; open-mode default outside a request. */
  private currentCtx(): { principal: Principal; correlationId: string } {
    return this.reqCtx.getStore() ?? { principal: openPrincipal(), correlationId: "" };
  }

  /**
   * The request/correlation id for this request: an `X-Correlation-Id` /
   * `X-Request-Id` header (sanitized, bounded) if the caller supplied one, else
   * a fresh UUID. Newlines are stripped so it can never forge an audit log line.
   */
  private correlationOf(req: ServeRequest): string {
    const raw = req.headers["x-correlation-id"] ?? req.headers["x-request-id"];
    if (typeof raw === "string") {
      const clean = raw.replace(/[\r\n]/g, "").trim().slice(0, 200);
      if (clean.length > 0) return clean;
    }
    return randomUUID();
  }

  /** 403 for a principal missing a required capability. */
  private forbidden(cap: Capability): ServeResponse {
    return this.error(403, "E_FORBIDDEN", `the principal lacks the "${cap}" capability`);
  }

  /**
   * Look up a run visible to the current principal. A run the principal does not
   * own (and cannot see all of) is indistinguishable from a nonexistent one, so
   * cross-principal access returns `undefined` → 404 rather than leaking that
   * the run exists.
   */
  private lookupRun(id: string): RunRecord | undefined {
    const record = this.runs.get(id);
    if (!record) return undefined;
    const { principal } = this.currentCtx();
    if (!principal.ownsAllRuns && record.principal !== principal.subject) return undefined;
    return record;
  }

  private handleV1(req: ServeRequest): ServeResponse | Promise<ServeResponse> {
    const { method, path } = req;
    const { principal } = this.currentCtx();

    if (path === "/v1/workflows") {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      const workflows = this.opts.getTools().map((t) => ({ name: t.name, description: t.description, params: t.params }));
      return this.json(200, { workflows });
    }

    const runPost = /^\/v1\/workflows\/([^/]+)\/runs$/.exec(path);
    if (runPost) {
      if (method !== "POST") return this.methodNotAllowed();
      if (!principal.capabilities.has("invoke")) return this.forbidden("invoke");
      return this.createRun(req, decodeURIComponent(runPost[1]));
    }

    if (path === "/v1/runs") {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      return this.listRuns(req);
    }

    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
    if (events) {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      return this.runEvents(req, decodeURIComponent(events[1]));
    }

    const artifactsList = /^\/v1\/runs\/([^/]+)\/artifacts$/.exec(path);
    if (artifactsList) {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      return this.listRunArtifacts(decodeURIComponent(artifactsList[1]));
    }

    const artifactGet = /^\/v1\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path);
    if (artifactGet) {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      return this.downloadArtifact(decodeURIComponent(artifactGet[1]), artifactGet[2]);
    }

    const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      if (method !== "POST") return this.methodNotAllowed();
      if (!principal.capabilities.has("cancel")) return this.forbidden("cancel");
      return this.cancelRun(decodeURIComponent(cancel[1]));
    }

    const getRun = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (getRun) {
      if (method !== "GET") return this.methodNotAllowed();
      if (!principal.capabilities.has("inspect")) return this.forbidden("inspect");
      const record = this.lookupRun(decodeURIComponent(getRun[1]));
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

    // Idempotency: a client that retries a create with the same key (scoped to
    // this principal + workflow) must never spawn a second expensive run.
    const idempotencyKey = req.headers["idempotency-key"];
    let composite: string | undefined;
    let argsHash: string | undefined;
    const principal = this.currentCtx().principal.subject;
    if (typeof idempotencyKey === "string" && idempotencyKey.trim() !== "") {
      composite = `${principal}\n${spec.workflow}\n${idempotencyKey.trim()}`;
      argsHash = hashArgs(args);
      const existingId = this.idempotencyIndex.get(composite);
      const existing = existingId ? this.runs.get(existingId) : undefined;
      if (existing) {
        // Same key, changed args → conflict, and never spawn.
        if (existing.args_hash !== argsHash) {
          return this.error(
            409,
            "E_IDEMPOTENCY_CONFLICT",
            `idempotency key already used for "${spec.name}" with different arguments`,
          );
        }
        // Same key, same args → return the original run verbatim.
        return this.json(200, this.toRunObject(existing));
      }
      // Stale index entry (its run was evicted): drop it and create fresh.
      if (existingId) this.idempotencyIndex.delete(composite);
    }

    const started = this.startRun(spec, args);
    if ("atCapacity" in started) {
      return this.error(429, "E_TOO_MANY_RUNS", `too many concurrent runs (max ${this.opts.maxConcurrent})`);
    }
    const { record, done } = started;

    // Reserve the key now (synchronously, before any await) so a concurrent
    // retry sees this run rather than racing to start a duplicate.
    if (composite) {
      record.idempotency_key = composite;
      record.principal = principal;
      record.args_hash = argsHash;
      this.idempotencyIndex.set(composite, record.run_id);
    }

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

    // Authorize the two capability-bearing MCP methods before doing any work:
    // `tools/call` needs `invoke`, `tools/list` needs `inspect`. An
    // insufficiently-scoped principal gets a JSON-RPC error and nothing spawns.
    const { principal } = this.currentCtx();
    const requiredCap: Capability | undefined =
      method === "tools/call" ? "invoke" : method === "tools/list" ? "inspect" : undefined;
    if (requiredCap && !principal.capabilities.has(requiredCap)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId ?? null,
          error: { code: -32003, message: `not authorized: the principal lacks the "${requiredCap}" capability` },
        }),
      };
    }

    // A tools/call may emit progress; stream it as SSE when the client offers
    // that content type. The client hanging up cancels the run through the same
    // MCP cancel path (kills the child + Docker container).
    if (requestId !== undefined && method === "tools/call" && wantsSse) {
      // The stream body runs after this method returns (outside the request's
      // AsyncLocalStorage scope), so capture the identity and re-establish it
      // there — otherwise the run this tools/call creates would be owned and
      // audited as the anonymous principal instead of the authenticated caller.
      const captured = this.currentCtx();
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
          return this.reqCtx.run(captured, () =>
            this.mcp.handleLine(req.body, (m) => {
              if (!target.aborted) target.write(`data: ${JSON.stringify(m)}\n\n`);
            }),
          );
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
    const { principal } = this.currentCtx();
    const limit = clampInt(req.query.get("limit"), DEFAULT_RUNS_PAGE, 1, MAX_RUNS_PAGE);
    const offset = clampInt(req.query.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    // Only runs the principal owns (all runs for the operator/open principal).
    const visible = [...this.runs.values()].filter((r) => principal.ownsAllRuns || r.principal === principal.subject);
    const sorted = visible.sort((a, b) => b.order - a.order);
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
        if (Number.isFinite(ended) && ended < cutoff) this.evict(r);
      }
    }
    const max = this.opts.retainRuns ?? 0;
    if (max > 0) {
      // Oldest terminal records first (ascending `order`); keep the newest `max`.
      const terminal = [...this.runs.values()].filter((r) => isTerminal(r.status)).sort((a, b) => a.order - b.order);
      for (let i = 0; i < terminal.length - max; i += 1) this.evict(terminal[i]);
    }
  }

  /**
   * Drop one record from the in-memory registry and its idempotency index
   * entry, so the index cannot grow past the retained-run set. The durable
   * `run.json` / journal on disk are untouched (the operator's to prune).
   */
  private evict(record: RunRecord): void {
    this.runs.delete(record.run_id);
    if (record.idempotency_key && this.idempotencyIndex.get(record.idempotency_key) === record.run_id) {
      this.idempotencyIndex.delete(record.idempotency_key);
    }
  }

  private cancelRun(id: string): ServeResponse {
    const record = this.lookupRun(id);
    if (!record) return this.error(404, "E_NOT_FOUND", "unknown run id");
    if (isTerminal(record.status)) {
      return this.error(409, "E_RUN_TERMINAL", `run is already ${record.status}`);
    }
    const { principal, correlationId } = this.currentCtx();
    this.opts.log?.(
      `jaiph serve: run ${id} cancelled — principal=${principal.subject} correlation=${correlationId || "-"}`,
    );
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
    const record = this.lookupRun(id);
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
    const record = this.lookupRun(id);
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
    const record = this.lookupRun(id);
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
    // Persist the public record beside the journal before eviction, so a
    // restart can reload this terminal run (and its idempotency key).
    this.opts.persistRun?.(record);
    this.evictCompleted();
  }

  private finalizeError(record: RunRecord, err: unknown): void {
    record.ended_at = this.opts.now();
    record.result_text = errText(err);
    record.status = record.cancelled ? "cancelled" : "failed";
    this.opts.persistRun?.(record);
    this.evictCompleted();
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
      // Audit identity + correlation on the public run object (never a token).
      principal: r.principal ?? null,
      correlation_id: r.correlation_id ?? null,
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
