import type { JaiphConfig } from "../../config";
import type { jaiphModule } from "../../types";
import type { MergedHookConfig } from "../run/hooks";
import type { OperatorLog } from "./server-log";

// Shared type surface and output-cap primitives for the workflow-call executor.
// Kept in a dependency-free leaf so the orchestrator (`workflow-call.ts`) and
// the executor (`workflow-call-exec.ts`) can both reference these shapes without
// an import cycle (dependency-cruiser follows type imports).

/**
 * Result of executing one workflow call. `text` is the same content an MCP
 * client sees (`composeResult`); `isError` is true when the workflow failed.
 * The `runDir` / `exitStatus` / `signal` fields let HTTP callers (`jaiph serve`)
 * populate a durable run object — MCP ignores them.
 */
export interface DefCallResult {
  /** Text returned to the caller as the call result. */
  text: string;
  /** True when the workflow failed; surfaces as `isError` on the result. */
  isError: boolean;
  /** Absolute run directory under `.jaiph/runs/`, when discoverable. */
  runDir?: string;
  /** Child exit status (0 on success). */
  exitStatus?: number;
  /** Terminating signal, when the child was killed. */
  signal?: NodeJS.Signals | null;
}

/**
 * Live hooks handed to `callDef` for one in-flight call. `onStep` fires per
 * `STEP_START`/`STEP_END` event; the executor registers its child-termination
 * function via `onCancelHandle` so a cancellation can kill the run.
 */
export interface DefCallContext {
  onStep?: (kind: string, name: string) => void;
  onCancelHandle?: (cancel: () => void) => void;
  /**
   * Authenticated principal (audit subject) for this call, attached to the
   * run's telemetry identity (OTLP resource attrs + Sentry tags). Never a
   * token or a secret-bearing claim.
   */
  principal?: string;
  /** Request/correlation id, attached to the run's telemetry identity. */
  correlationId?: string;
  /**
   * Operator-log wiring for per-call banner lines + the optional workflow-log
   * mirror. Injected by the command layer (`jaiph mcp` / `jaiph serve`); the
   * run handler and MCP engine never see it.
   */
  operator?: OperatorLog;
}

/**
 * Everything a workflow call needs from the server session. Built once per
 * module-graph generation (startup and each hot reload) — scripts and the
 * serialized graph are read-only, so concurrent calls can share them.
 */
export interface DefCallEnvironment {
  inputAbs: string;
  workspaceRoot: string;
  /** Entry module AST for this generation. */
  mod: jaiphModule;
  effectiveConfig: JaiphConfig;
  /** Emitted scripts dir for this generation (`buildScriptsFromGraph`). */
  scriptsDir: string;
  /** Serialized module graph consumed by the spawned runner. */
  graphFile: string;
  /** Generation dir for per-call meta files. */
  outDir: string;
  /**
   * Resolved `--env` passthrough applied to every call for the server's
   * lifetime. Merged into the runner env.
   */
  extraEnv: Record<string, string>;
  /**
   * Merged lifecycle-hook config (`hooks.json`), loaded once per generation.
   * When present, every call dispatches the same four hook events as
   * interactive `jaiph run` (`run_start`, `step_start`, `step_end`,
   * `run_end`) with the same payload shapes.
   */
  hooks?: MergedHookConfig;
}

/** Output accumulated from a run child's streams while it executes. */
export interface CollectedOutput {
  logs: string[];
  failedStep?: { name: string; detail: string };
  rawStderr: string;
  rawStdout: string;
}

/**
 * Byte caps that bound one call's in-memory capture. A long-lived server
 * (`jaiph serve`) can be driven by an authenticated caller into producing
 * unbounded stdout/stderr/log output; these caps stop a single run from
 * exhausting process memory, and bound the `result_text` the server keeps
 * resident per run. Each field is measured in UTF-8 bytes. The defaults keep an
 * ordinary run's full output; the server lowers them via env when needed.
 */
export interface OutputCaps {
  /** Max bytes retained for raw stdout capture. */
  stdout: number;
  /** Max bytes retained for raw stderr capture. */
  stderr: number;
  /** Max bytes retained across all collected `log` messages. */
  logs: number;
  /** Max bytes of the composed, returned `result_text`. */
  resultText: number;
}

/**
 * Effectively-unbounded caps — the default for every caller that does not opt
 * in (`jaiph mcp`, direct callers), so their existing behavior is unchanged.
 * Only the long-lived HTTP service (`jaiph serve`) passes finite caps.
 */
export const DEFAULT_OUTPUT_CAPS: OutputCaps = {
  stdout: Number.MAX_SAFE_INTEGER,
  stderr: Number.MAX_SAFE_INTEGER,
  logs: Number.MAX_SAFE_INTEGER,
  resultText: Number.MAX_SAFE_INTEGER,
};

/**
 * Deterministic marker appended to any captured stream or result text cut at a
 * cap, so a truncated response is self-describing rather than silently short.
 */
export const TRUNCATION_MARKER = "\n[jaiph: output truncated — exceeded the configured byte cap]";

/** Cap `text` to `cap` UTF-8 bytes, appending {@link TRUNCATION_MARKER} on overflow. */
export function capBytes(text: string, cap: number): string {
  if (Buffer.byteLength(text) <= cap) return text;
  const head = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8").replace(/�+$/, "");
  return head + TRUNCATION_MARKER;
}
