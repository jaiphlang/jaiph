import type { JaiphConfig } from "../../config";
import type { jaiphModule } from "../../types";
import type { SandboxFlags } from "../run/env";
import type { MergedHookConfig } from "../run/hooks";
import type { DockerRunConfig, SandboxMode } from "../../runtime";
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
export interface WorkflowCallResult {
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
 * Live hooks handed to `callWorkflow` for one in-flight call. `onStep` fires per
 * `STEP_START`/`STEP_END` event; the executor registers its child-termination
 * function via `onCancelHandle` so a cancellation can kill the run.
 */
export interface WorkflowCallContext {
  onStep?: (kind: string, name: string) => void;
  onCancelHandle?: (cancel: () => void) => void;
  /**
   * Authenticated principal (audit subject) for this call, attached to the
   * run's telemetry identity (OTLP resource attributes + Sentry tags). Never a
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
export interface WorkflowCallEnvironment {
  inputAbs: string;
  workspaceRoot: string;
  /**
   * Entry module AST for this generation. Docker calls scan it for the
   * backends in play (`collectEntryBackends`) so the sandbox forwards only
   * those backends' credential keys.
   */
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
   * lifetime. Host execution merges it into the runner env; Docker execution
   * threads it through `DockerSpawnOptions.extraEnv` — this is the single
   * choke point either way.
   */
  extraEnv: Record<string, string>;
  /**
   * Sandbox flags from the server's CLI surface (`--inplace` / `--unsafe` /
   * `--yes`), applied to every call's runtime env exactly as `jaiph run`
   * applies them, so the child observes the same `JAIPH_*` posture vars in
   * every mode. Conflicts were already rejected at server startup.
   */
  sandboxFlags?: SandboxFlags;
  /**
   * Merged lifecycle-hook config (`hooks.json`), loaded once per generation.
   * When present, every call dispatches the same four hook events as
   * interactive `jaiph run` (`workflow_start`, `step_start`, `step_end`,
   * `workflow_end`) with the same payload shapes.
   */
  hooks?: MergedHookConfig;
}

/**
 * Sandbox posture for a workflow server, resolved **once at startup**
 * (`resolveStartupPosture`) and applied verbatim to every call — a call never
 * re-derives Docker enablement or the sandbox mode from its own env.
 */
export interface ExecutionPosture {
  dockerConfig: DockerRunConfig;
  sandboxMode: SandboxMode;
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
  // Slice on a byte boundary, then drop a trailing partial multibyte char
  // (which `toString` decodes to U+FFFD) so the head stays valid UTF-8.
  const head = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8").replace(/�+$/, "");
  return head + TRUNCATION_MARKER;
}
