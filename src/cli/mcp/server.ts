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

export interface McpServerOptions {
  serverVersion: string;
  /** Current tool list (re-read on every request so hot reload just works). */
  getTools: () => McpToolSpec[];
  /** Execute one workflow call; must never write to stdout. */
  callTool: (spec: McpToolSpec, args: Record<string, string>) => Promise<McpCallResult>;
  /** Outbound protocol message (one JSON line on stdout). */
  write: (message: Record<string, unknown>) => void;
  /** Diagnostic line (stderr). */
  log: (message: string) => void;
}

type JsonRpcId = string | number;

export class McpServer {
  private readonly opts: McpServerOptions;
  private initialized = false;

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

    // Responses from the client (to server-initiated requests) and unknown
    // notifications are ignored; only requests need an answer.
    if (method === undefined) return;
    if (!hasId) {
      // Notification. `notifications/initialized` etc. — nothing to do.
      return;
    }

    const params =
      typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};

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

    try {
      const result = await this.opts.callTool(spec, args);
      this.writeResult(id, {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`jaiph mcp: tool "${spec.name}" crashed: ${message}`);
      this.writeError(id, JSONRPC_INTERNAL_ERROR, `tool "${spec.name}" failed: ${message}`);
    }
  }

  private writeResult(id: JsonRpcId, result: Record<string, unknown>): void {
    this.opts.write({ jsonrpc: "2.0", id, result });
  }

  private writeError(id: JsonRpcId | null, code: number, message: string): void {
    this.opts.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
