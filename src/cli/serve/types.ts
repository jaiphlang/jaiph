import type { McpToolSpec } from "../shared/mcp-tools";
import type { WorkflowCallResult, WorkflowCallContext } from "../shared/workflow-call";
import type { StreamTarget } from "./runfiles";
import type { Authenticator } from "./auth";

/**
 * `interrupted` is a terminal state reserved for a run that was `running` when
 * the serving process died: on restart it is reconciled out of `running` (a run
 * is never reported as permanently running) but its real outcome is unknown, so
 * it is neither `succeeded` nor `failed`.
 */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

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
   * Composite idempotency key (`principal\nworkflow\nkey`) this run reserved, so
   * eviction can drop the index entry and startup can rebuild the index. Absent
   * when the create carried no `Idempotency-Key`.
   */
  idempotency_key?: string;
  /**
   * Authenticated principal (subject) that created the run. The audit identity
   * — never a token — that also scopes idempotency and ownership. Persisted for
   * reconstruction. `anonymous`/`operator` in open/static mode.
   */
  principal?: string;
  /** Request/correlation id attached at create time (audit + telemetry). */
  correlation_id?: string;
  /** SHA-256 of the run's canonical args, compared to reject a reused key with changed args. */
  args_hash?: string;
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
  /**
   * Static single-operator bearer token. When set (and no `authenticator` is
   * injected) every `/v1/*` and `/mcp` request must present it. Single-operator,
   * not multi-tenant — for per-user identity/authorization pass an `authenticator`.
   */
  token?: string;
  /**
   * Authentication/authorization engine. When omitted the handler builds one
   * from `token` (static) or, with neither, open mode (anonymous, all
   * capabilities). The serve command injects the OIDC/JWT authenticator here.
   */
  authenticator?: Authenticator;
  /**
   * Expose `GET /docs` (Swagger UI) and `GET /openapi.json`. Default `true`;
   * `false` returns 404 for both so a hardened deployment can hide its API
   * surface. `/healthz` is always available and credential-free.
   */
  exposeDocs?: boolean;
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
  /**
   * Records reconstructed from the durable runs tree at startup (terminal runs
   * reloaded from their persisted `run.json`, plus interrupted runs reconciled
   * out of `running`). Seeded into the registry before the first request so
   * list/get/events/artifacts and idempotency survive a process restart. The
   * order is oldest-first; the handler assigns monotonic `order`.
   */
  initialRuns?: RunRecord[];
  /**
   * Persist a run's public record beside its journal when it finalizes, so a
   * later restart can reload it. Defaults to a no-op (tests that don't exercise
   * durability skip it); the serve command supplies the real filesystem writer.
   */
  persistRun?: (record: RunRecord) => void;
}
