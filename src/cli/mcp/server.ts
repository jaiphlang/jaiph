import type { McpToolSpec } from "./tools";

/**
 * Minimal MCP server over newline-delimited JSON-RPC 2.0 (stdio transport).
 *
 * The transport and the workflow execution are injected so the protocol layer
 * stays a pure line-in / message-out state machine (unit-testable without
 * spawning processes). Handles: `initialize`, `ping`, `tools/list`,
 * `tools/call`; emits `notifications/tools/list_changed` on hot reload.
 * All diagnostics go through `log` (stderr) — stdout carries protocol JSON only.
 */

/** MCP protocol revisions this server knows; the newest is the fallback. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpCallResult {
  /** Text returned to the client as the tool result. */
  text: string;
  /** True when the workflow failed; surfaces as `isError` on the result. */
  isError: boolean;
}

/**
 * Live hooks handed to `callTool` for one in-flight call. `onStep` fires per
 * `STEP_START`/`STEP_END` event (drives `notifications/progress`); the executor
 * registers its child-termination function via `onCancelHandle` so a
 * `notifications/cancelled` for this request id can kill the run.
 */
export interface McpCallContext {
  onStep?: (kind: string, name: string) => void;
  onCancelHandle?: (cancel: () => void) => void;
}

export interface McpServerOptions {
  serverVersion: string;
  /** Current tool list (re-read on every request so hot reload just works). */
  getTools: () => McpToolSpec[];
  /** Execute one workflow call; must never write to stdout. */
  callTool: (
    spec: McpToolSpec,
    args: Record<string, string>,
    ctx: McpCallContext,
  ) => Promise<McpCallResult>;
  /** Outbound protocol message (one JSON line on stdout). */
  write: (message: Record<string, unknown>) => void;
  /** Diagnostic line (stderr). */
  log: (message: string) => void;
}

type JsonRpcId = string | number;

/** Bookkeeping for one in-flight `tools/call` so it can be cancelled. */
interface InFlightCall {
  /** Set once the client requests cancellation for this request id. */
  cancelled: boolean;
  /** Terminates the running child; populated once the executor spawns it. */
  cancelRun?: () => void;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

/** Read `params._meta.progressToken` (string or number) if present. */
function readProgressToken(params: Record<string, unknown>): JsonRpcId | undefined {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const token = (meta as Record<string, unknown>).progressToken;
  return isJsonRpcId(token) ? token : undefined;
}

export class McpServer {
  private readonly opts: McpServerOptions;
  private initialized = false;
  /** In-flight `tools/call` requests keyed by request id (for cancellation). */
  private readonly inFlight = new Map<JsonRpcId, InFlightCall>();

  constructor(opts: McpServerOptions) {
    this.opts = opts;
  }

  /** Tell connected clients the tool list changed (hot reload). */
  notifyToolsChanged(): void {
    if (!this.initialized) return;
    this.opts.write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /** Handle one inbound line. Async because `tools/call` runs a workflow. */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.writeError(null, JSONRPC_INVALID_REQUEST, "request must be a JSON object");
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      this.writeError(null, JSONRPC_PARSE_ERROR, "parse error: invalid JSON");
      return;
    }

    const method = typeof message.method === "string" ? message.method : undefined;
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    const id = hasId ? (message.id as JsonRpcId) : undefined;

    const params =
      typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};

    // Responses from the client (to server-initiated requests) and unknown
    // notifications are ignored; only requests need an answer.
    if (method === undefined) return;
    if (!hasId) {
      // Notification. `notifications/cancelled` aborts an in-flight call;
      // everything else (`notifications/initialized`, …) is a no-op.
      if (method === "notifications/cancelled") this.handleCancelled(params);
      return;
    }

    switch (method) {
      case "initialize":
        this.handleInitialize(id!, params);
        return;
      case "ping":
        this.writeResult(id!, {});
        return;
      case "tools/list":
        this.handleToolsList(id!);
        return;
      case "tools/call":
        await this.handleToolsCall(id!, params);
        return;
      default:
        this.writeError(id!, JSONRPC_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private handleInitialize(id: JsonRpcId, params: Record<string, unknown>): void {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    this.initialized = true;
    this.writeResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "jaiph", title: "Jaiph workflows", version: this.opts.serverVersion },
    });
  }

  private handleToolsList(id: JsonRpcId): void {
    const tools = this.opts.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this.writeResult(id, { tools });
  }

  private async handleToolsCall(id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
    const name = typeof params.name === "string" ? params.name : "";
    const spec = this.opts.getTools().find((t) => t.name === name);
    if (!spec) {
      this.writeError(id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name || "(missing name)"}`);
      return;
    }

    const rawArgs =
      typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    const missing = spec.params.filter((p) => typeof rawArgs[p] !== "string");
    if (missing.length > 0) {
      this.writeError(
        id,
        JSONRPC_INVALID_PARAMS,
        `missing or non-string argument(s) for tool "${spec.name}": ${missing.join(", ")}`,
      );
      return;
    }
    const unknown = Object.keys(rawArgs).filter((k) => !spec.params.includes(k));
    if (unknown.length > 0) {
      this.writeError(
        id,
        JSONRPC_INVALID_PARAMS,
        `unknown argument(s) for tool "${spec.name}": ${unknown.join(", ")}`,
      );
      return;
    }

    const args: Record<string, string> = {};
    for (const p of spec.params) args[p] = rawArgs[p] as string;

    // Track this call so a `notifications/cancelled` for `id` can kill it.
    const entry: InFlightCall = { cancelled: false };
    this.inFlight.set(id, entry);
    const ctx = this.buildCallContext(id, entry, readProgressToken(params));
    try {
      const result = await this.opts.callTool(spec, args, ctx);
      // A cancelled call must not produce a response (spec requirement).
      if (entry.cancelled) return;
      this.writeResult(id, {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      });
    } catch (err) {
      if (entry.cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`jaiph mcp: tool "${spec.name}" crashed: ${message}`);
      this.writeError(id, JSONRPC_INTERNAL_ERROR, `tool "${spec.name}" failed: ${message}`);
    } finally {
      // Drop the entry only after the response is sent: `onStep` gates progress
      // notifications on `inFlight.has(id)`, so this also stops late progress.
      this.inFlight.delete(id);
    }
  }

  /**
   * Wire the executor hooks for one call: translate step events into monotonic
   * `notifications/progress` (only when the client sent a progressToken) and
   * capture the child-termination function for cancellation.
   */
  private buildCallContext(
    id: JsonRpcId,
    entry: InFlightCall,
    progressToken: JsonRpcId | undefined,
  ): McpCallContext {
    let progress = 0;
    return {
      onStep:
        progressToken === undefined
          ? undefined
          : (kind, name): void => {
              // Suppress once the call is cancelled or its response was sent.
              if (entry.cancelled || !this.inFlight.has(id)) return;
              progress += 1;
              this.opts.write({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken, progress, message: `${kind} ${name}`.trim() },
              });
            },
      onCancelHandle: (cancel): void => {
        entry.cancelRun = cancel;
        // Cancellation may arrive before the child is spawned; honor it now.
        if (entry.cancelled) cancel();
      },
    };
  }

  /** Terminate the child of an in-flight call named by `notifications/cancelled`. */
  private handleCancelled(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    if (!isJsonRpcId(requestId)) return;
    const entry = this.inFlight.get(requestId);
    if (!entry) return;
    entry.cancelled = true;
    entry.cancelRun?.();
  }

  private writeResult(id: JsonRpcId, result: Record<string, unknown>): void {
    this.opts.write({ jsonrpc: "2.0", id, result });
  }

  private writeError(id: JsonRpcId | null, code: number, message: string): void {
    this.opts.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
