import { canUseAnsi, type SandboxMode } from "../../runtime";
import { buildAsyncIndent, colorize, sandboxParenLabel, type ColorCode } from "./log-format";

// Operator log for the long-lived workflow servers `jaiph mcp` and `jaiph serve`.
// It is deliberately NOT a logging framework (no winston / pino / bunyan — that
// would pull a dependency into a package that solved "write a line to stderr"
// with `process.stderr.write`): it wraps the existing injectable stderr `log`
// sink with a label prefix, level colors, and grep-friendly `key=value` tails.
//
// Two channels stay separate. This operator log goes to **stderr only** —
// lifecycle notices, per-call banners, and (opt-in) a mirror of workflow log
// events. It is never written to MCP stdout (JSON-RPC only) or into an HTTP
// response body (API payloads only). Workflow LOG/LOGWARN/LOGERR events keep
// their own contract (run_summary.jsonl + the call result text); mirroring them
// here is opt-in via JAIPH_SERVER_LOG_WORKFLOW.

/** Level of a mirrored workflow log event (drives the mirror line color). */
export type MirrorLevel = "LOG" | "LOGWARN" | "LOGERR";

export interface ServerLog {
  /** Routine operator line (per-call start/end, lifecycle). Plain, grep-friendly. */
  info(message: string): void;
  /** Warning line — yellow when colors are on. */
  warn(message: string): void;
  /** Error line — red when colors are on. */
  error(message: string): void;
  /** Verbose line, emitted only under JAIPH_SERVER_LOG=debug. */
  debug(message: string): void;
  /** True when JAIPH_SERVER_LOG_WORKFLOW opts into mirroring workflow log events. */
  readonly mirrorWorkflowLog: boolean;
  /**
   * Mirror one workflow log event to the operator log, colorized by level with
   * the same depth / async-branch subscript indent the interactive `jaiph run`
   * tree uses. The caller must pass an already credential-redacted `message`
   * (the same boundary as the durable journal / call-result text).
   */
  mirror(level: MirrorLevel, message: string, ctx: MirrorContext): void;
}

/** Per-event context for a mirrored workflow log line. */
export interface MirrorContext {
  runId: string;
  depth: number;
  asyncIndices: number[];
}

/**
 * Operator-log wiring for one workflow call: the {@link ServerLog} plus the
 * server's constant sandbox label. Injected by the command layer into a
 * `WorkflowCallContext` so `callWorkflow` (the shared choke point for both
 * `jaiph mcp` and `jaiph serve`) emits per-call banners through one path.
 */
export interface OperatorLog {
  log: ServerLog;
  /** Effective sandbox label for this server (`sandboxParenLabel`), constant per call. */
  sandboxLabel: string;
}

/**
 * Build the {@link OperatorLog} a server hands to every call: a {@link ServerLog}
 * over the injectable stderr `write` sink (colors only on a TTY sink with
 * `NO_COLOR` unset, verbosity/mirror knobs read from the process env) plus the
 * sandbox label resolved once from the startup posture. One factory so `jaiph
 * mcp` and `jaiph serve` wire the operator log identically with a single import.
 */
export function createOperatorLog(opts: {
  label: string;
  write: (line: string) => void;
  dockerEnabled: boolean;
  sandboxMode: SandboxMode;
  unsafeHostOnly: boolean;
}): OperatorLog {
  return {
    log: createServerLog({
      label: opts.label,
      write: opts.write,
      colorEnabled: canUseAnsi(process.stderr),
      ...resolveServerLogEnv(process.env),
    }),
    sandboxLabel: sandboxParenLabel(opts.dockerEnabled, opts.sandboxMode, opts.unsafeHostOnly),
  };
}

/** Read the operator-log env knobs (documented in docs/env-vars.md). */
export function resolveServerLogEnv(env: NodeJS.ProcessEnv): {
  debugEnabled: boolean;
  mirrorWorkflowLog: boolean;
} {
  return {
    debugEnabled: /^debug$/i.test((env.JAIPH_SERVER_LOG ?? "").trim()),
    mirrorWorkflowLog: /^(1|true)$/i.test((env.JAIPH_SERVER_LOG_WORKFLOW ?? "").trim()),
  };
}

/**
 * Build an operator log over an injectable stderr `write` sink. `label` is the
 * command prefix (`jaiph mcp` / `jaiph serve`). Colors are applied only when
 * `colorEnabled` (a TTY sink with `NO_COLOR` unset) — never in a pipe or CI.
 * The `write` seam keeps the whole thing unit-testable: a test injects a capture
 * sink and asserts on the lines, exactly like the existing `log` sink.
 */
export function createServerLog(opts: {
  label: string;
  write: (line: string) => void;
  colorEnabled: boolean;
  debugEnabled?: boolean;
  mirrorWorkflowLog?: boolean;
}): ServerLog {
  const { label, write, colorEnabled } = opts;
  const debugEnabled = opts.debugEnabled ?? false;
  const mirrorWorkflowLog = opts.mirrorWorkflowLog ?? false;
  const emit = (message: string, code?: ColorCode): void => {
    const line = `${label}: ${message}`;
    write(code ? colorize(line, code, colorEnabled) : line);
  };
  return {
    mirrorWorkflowLog,
    info: (message) => emit(message),
    warn: (message) => emit(message, "yellow"),
    error: (message) => emit(message, "red"),
    debug: (message) => {
      if (debugEnabled) emit(message, "dim");
    },
    mirror: (level, message, ctx) => {
      const code: ColorCode = level === "LOGERR" ? "red" : level === "LOGWARN" ? "yellow" : "blue";
      const body = `${buildAsyncIndent(ctx.depth, ctx.asyncIndices)}${message}`;
      const colored = colorEnabled ? colorize(body, code, true) : body;
      write(`${label}: ${colored} run_id=${ctx.runId}`);
    },
  };
}

/** Fields for the per-call start banner line. */
export interface CallStartFields {
  /** Workflow symbol or entry basename. */
  workflow: string;
  /** Effective sandbox label (`sandboxParenLabel`). */
  sandboxLabel: string;
  runId: string;
  /** Present only when the run dir is already known (rarely at start). */
  rundir?: string;
  /** Serve attaches the audit principal; mcp omits it. */
  principal?: string;
  correlationId?: string;
}

/**
 * One-line per-call start banner, e.g.
 * `Running engineer (Docker sandbox, unsafe) run_id=… rundir=… principal=…`.
 * The sandbox label is always parenthesized so an operator sees the posture the
 * call ran under; `run_id` and `rundir` are grep-friendly `key=value` tails.
 */
export function formatCallStartLine(f: CallStartFields): string {
  const parts = [`Running ${f.workflow} (${f.sandboxLabel})`, `run_id=${f.runId}`];
  if (f.rundir) parts.push(`rundir=${f.rundir}`);
  if (f.principal) parts.push(`principal=${f.principal}`);
  if (f.correlationId) parts.push(`correlation=${f.correlationId}`);
  return parts.join(" ");
}

/** Fields for the per-call end banner line. */
export interface CallEndFields {
  workflow: string;
  /** Terminal disposition of the call. */
  status: "ok" | "failed" | "cancelled";
  exit: number;
  elapsedMs: number;
  rundir?: string;
  principal?: string;
  correlationId?: string;
}

/**
 * One-line per-call end banner, e.g.
 * `Finished engineer status=ok exit=0 elapsed_ms=1234 rundir=…`. Carries the
 * terminal status, exit code, elapsed wall time, and the run dir when known.
 */
export function formatCallEndLine(f: CallEndFields): string {
  const parts = [
    `Finished ${f.workflow}`,
    `status=${f.status}`,
    `exit=${f.exit}`,
    `elapsed_ms=${f.elapsedMs}`,
  ];
  if (f.rundir) parts.push(`rundir=${f.rundir}`);
  if (f.principal) parts.push(`principal=${f.principal}`);
  if (f.correlationId) parts.push(`correlation=${f.correlationId}`);
  return parts.join(" ");
}
