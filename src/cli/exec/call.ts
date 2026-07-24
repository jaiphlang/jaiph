import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { JaiphConfig } from "../../config";
import type { jaiphModule } from "../../types";
import { spawnRunProcess, waitForRunExit, cancelRunProcess } from "../run/lifecycle";
import { resolveRuntimeEnv } from "../run/env";
import { collectEntryBackends } from "../run/preflight-credentials";
import { parseLogEvent, parseStepEvent } from "../run/events";
import {
  spawnDockerProcess,
  stopDockerContainer,
  withDockerExitGuard,
  resolveDockerHostRunsRoot,
  selectMcpSandboxMode,
  type DockerRunConfig,
} from "../../runtime/docker";
import { discoverDockerRunDir, remapContainerPath } from "../shared/errors";
import { exportRunTelemetry } from "../telemetry/otlp";
import { redactCredentials } from "../../runtime/kernel/redact";

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
  const head = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8").replace(/\uFFFD+$/, "");
  return head + TRUNCATION_MARKER;
}

/**
 * Execute one workflow call. Honors the same env-driven sandbox selection as
 * `jaiph run`: when `dockerConfig.enabled`, the call runs in a per-call
 * container (workspace isolated by default; inplace when JAIPH_INPLACE=1);
 * otherwise it runs on the host like `jaiph run --raw`.
 *
 * The caller supplies `runId` so it can register the run before the child
 * exits (the HTTP server needs the id while the run is still `running`).
 *
 * Success text, in order of preference: the workflow's return value
 * (`return_value.txt`), collected `log` output, or a completion note.
 */
export async function callWorkflow(
  env: WorkflowCallEnvironment,
  dockerConfig: DockerRunConfig,
  workflowSymbol: string,
  positionalArgs: string[],
  runId: string,
  ctx?: WorkflowCallContext,
  caps: OutputCaps = DEFAULT_OUTPUT_CAPS,
): Promise<WorkflowCallResult> {
  const runtimeEnv = resolveRuntimeEnv(env.effectiveConfig, env.workspaceRoot, env.inputAbs);
  runtimeEnv.JAIPH_SOURCE_ABS = env.inputAbs;
  runtimeEnv.JAIPH_RUN_ID = runId;
  runtimeEnv.JAIPH_SCRIPTS = env.scriptsDir;

  const result = dockerConfig.enabled
    ? await callWorkflowDocker(env, dockerConfig, workflowSymbol, positionalArgs, runtimeEnv, runId, caps, ctx)
    : await callWorkflowHost(env, workflowSymbol, positionalArgs, runtimeEnv, runId, caps, ctx);
  // One export per call — the shared choke point covering every MCP tool call and
  // HTTP `jaiph serve` invocation. Best-effort; never changes the call result.
  await exportRunTelemetry({
    runDir: result.runDir,
    workflow: workflowSymbol,
    exitStatus: result.exitStatus ?? 0,
    signal: result.signal ?? null,
    env: process.env,
  });
  return result;
}

/** Host execution — same self-spawn path as `jaiph run --raw`. */
async function callWorkflowHost(
  env: WorkflowCallEnvironment,
  workflowSymbol: string,
  positionalArgs: string[],
  runtimeEnv: Record<string, string | undefined>,
  runId: string,
  caps: OutputCaps,
  ctx?: WorkflowCallContext,
): Promise<WorkflowCallResult> {
  runtimeEnv.JAIPH_MODULE_GRAPH_FILE = env.graphFile;
  // `--env` passthrough defines the workflow process's env, overriding
  // inherited values, on every call.
  Object.assign(runtimeEnv, env.extraEnv);

  const metaFile = join(env.outDir, `.jaiph-run-meta-${runId}.txt`);
  const dummyBuiltPath = join(env.outDir, "entry.sh");

  const child = spawnRunProcess([metaFile, dummyBuiltPath, workflowSymbol, ...positionalArgs], {
    cwd: env.workspaceRoot,
    env: runtimeEnv,
  });
  ctx?.onCancelHandle?.(() => cancelRunProcess(child));
  const collector = attachOutputCollector(child, ctx?.onStep, caps);
  const exit = await waitForRunExit(child);
  collector.drain();

  const meta = readMetaFile(metaFile);
  return composeResult(workflowSymbol, collector.data, exit, meta.runDir, undefined, runtimeEnv, caps);
}

/**
 * Container execution — the same Docker path as `jaiph run`. The workflow
 * symbol is carried into the container so a non-`default` call runs correctly.
 * Sandbox mode matches `jaiph run` (isolated by default; inplace when
 * JAIPH_INPLACE=1). The container meta file is inaccessible from the host, so
 * the run dir is discovered from the sandbox runs mount.
 */
async function callWorkflowDocker(
  env: WorkflowCallEnvironment,
  dockerConfig: DockerRunConfig,
  workflowSymbol: string,
  positionalArgs: string[],
  runtimeEnv: Record<string, string | undefined>,
  runId: string,
  caps: OutputCaps,
  ctx?: WorkflowCallContext,
): Promise<WorkflowCallResult> {
  const sandboxMode = selectMcpSandboxMode(runtimeEnv);
  const sandboxRunDir = resolveDockerHostRunsRoot(env.workspaceRoot, runtimeEnv);
  const dockerResult = spawnDockerProcess({
    config: dockerConfig,
    sourceAbs: env.inputAbs,
    workspaceRoot: env.workspaceRoot,
    sandboxRunDir,
    runArgs: positionalArgs,
    env: runtimeEnv,
    extraEnv: env.extraEnv,
    backends: collectEntryBackends(env.mod, runtimeEnv),
    isTTY: false,
    sandboxMode,
    workflowSymbol,
  });
  // Cancel must also stop+remove the container: a `docker run --rm` container
  // can outlive its killed client, orphaning the sandboxed work.
  ctx?.onCancelHandle?.(() => {
    stopDockerContainer(dockerResult.containerName);
    cancelRunProcess(dockerResult.child);
  });
  const collector = attachOutputCollector(dockerResult.child, ctx?.onStep, caps);
  return withDockerExitGuard(dockerResult, async () => {
    const exit = await waitForRunExit(dockerResult.child);
    collector.drain();
    const discovered = discoverDockerRunDir(sandboxRunDir, runId);
    // Docker keeps `--env` passthrough out of runtimeEnv (it flows through
    // DockerSpawnOptions.extraEnv), so merge it back in for redaction.
    return composeResult(
      workflowSymbol,
      collector.data,
      exit,
      discovered.runDir,
      sandboxRunDir,
      { ...runtimeEnv, ...env.extraEnv },
      caps,
    );
  });
}

/**
 * Attach line-oriented listeners to a run child's stderr/stdout. Parses
 * `__JAIPH_EVENT__` log/step lines from stderr (child stdout is captured but
 * never forwarded). `onStep` (when given) fires once per `STEP_START`/`STEP_END`
 * event so the caller can stream progress. `drain()` flushes any trailing
 * partial stderr line.
 */
export function attachOutputCollector(
  child: ChildProcess,
  onStep: ((kind: string, name: string) => void) | undefined,
  caps: OutputCaps,
): { data: CollectedOutput; drain: () => void } {
  const data: CollectedOutput = { logs: [], rawStderr: "", rawStdout: "" };
  // Per-stream byte counters + one-shot "cut" flags so accumulation stops at the
  // cap (each stream overshoots by at most one over-cap chunk, which is then
  // dropped) and the truncation marker is recorded exactly once.
  let logsBytes = 0;
  let logsCut = false;
  let stderrBytes = 0;
  let stderrCut = false;
  let stdoutBytes = 0;
  let stdoutCut = false;

  const onStderrLine = (line: string): void => {
    const logEvent = parseLogEvent(line);
    if (logEvent) {
      if (!logsCut) {
        const b = Buffer.byteLength(logEvent.message);
        if (logsBytes + b <= caps.logs) {
          data.logs.push(logEvent.message);
          logsBytes += b;
        } else {
          data.logs.push(TRUNCATION_MARKER.trim());
          logsCut = true;
        }
      }
      return;
    }
    const stepEvent = parseStepEvent(line);
    if (stepEvent) {
      if (
        stepEvent.type === "STEP_END" &&
        stepEvent.status !== null &&
        stepEvent.status !== 0 &&
        !data.failedStep
      ) {
        const detail = stepEvent.err_content.trim() || stepEvent.out_content.trim();
        data.failedStep = { name: `${stepEvent.kind} ${stepEvent.name}`.trim(), detail };
      }
      onStep?.(stepEvent.kind, stepEvent.name);
      return;
    }
    if (!stderrCut) {
      const add = `${line}\n`;
      const b = Buffer.byteLength(add);
      if (stderrBytes + b <= caps.stderr) {
        data.rawStderr += add;
        stderrBytes += b;
      } else {
        data.rawStderr += TRUNCATION_MARKER;
        stderrCut = true;
      }
    }
  };

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuf += chunk;
    let idx = stderrBuf.indexOf("\n");
    while (idx !== -1) {
      onStderrLine(stderrBuf.slice(0, idx).replace(/\r$/, ""));
      stderrBuf = stderrBuf.slice(idx + 1);
      idx = stderrBuf.indexOf("\n");
    }
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdoutCut) return;
    const b = Buffer.byteLength(chunk);
    if (stdoutBytes + b <= caps.stdout) {
      data.rawStdout += chunk;
      stdoutBytes += b;
    } else {
      data.rawStdout += TRUNCATION_MARKER;
      stdoutCut = true;
    }
  });

  return {
    data,
    drain: (): void => {
      if (stderrBuf.length > 0) onStderrLine(stderrBuf.replace(/\r$/, ""));
    },
  };
}

/**
 * Compose the call result text from a finished run's output + run dir.
 *
 * Diagnostic capture — failed-step detail, raw stderr/stdout, and collected
 * `log` messages — is credential-redacted here, the single boundary both
 * `jaiph serve` (`result_text`, `?wait=true`, `GET /v1/runs/{id}`) and
 * `jaiph mcp` (tool results) return through. Live `__JAIPH_EVENT__` lines are
 * not redacted at the source, so this must not rely on the event stream.
 * A successful workflow's return value is intentional API output, not
 * diagnostic capture, and is returned verbatim.
 *
 * The composed `text` is capped at `caps.resultText` bytes (with a deterministic
 * truncation marker) as the final backstop: it is the value a long-lived
 * `jaiph serve` keeps resident per run, so an unbounded return value or log
 * dump cannot grow the run registry without limit.
 */
export function composeResult(
  workflowSymbol: string,
  data: CollectedOutput,
  exit: { status: number; signal: NodeJS.Signals | null },
  runDir: string | undefined,
  sandboxRunDir: string | undefined,
  env: NodeJS.ProcessEnv,
  caps: OutputCaps = DEFAULT_OUTPUT_CAPS,
): WorkflowCallResult {
  const failed = exit.status !== 0 || exit.signal !== null;

  if (!failed) {
    const returnValue = readReturnValue(runDir, sandboxRunDir);
    const text =
      returnValue !== undefined && returnValue.length > 0
        ? returnValue
        : data.logs.length > 0
          ? redactCredentials(data.logs.join("\n"), env)
          : `workflow ${workflowSymbol} completed`;
    return {
      text: capBytes(trimTrailingNewline(text), caps.resultText),
      isError: false,
      runDir,
      exitStatus: exit.status,
      signal: exit.signal,
    };
  }

  const parts: string[] = [];
  parts.push(
    exit.signal
      ? `workflow ${workflowSymbol} terminated by signal ${exit.signal}`
      : `workflow ${workflowSymbol} failed (exit ${exit.status})`,
  );
  if (data.failedStep) {
    parts.push(`failed step: ${data.failedStep.name}`);
    if (data.failedStep.detail) parts.push(data.failedStep.detail);
  }
  const stderrTrimmed = data.rawStderr.trim();
  if (stderrTrimmed) parts.push(stderrTrimmed);
  const stdoutTrimmed = data.rawStdout.trim();
  if (!data.failedStep && !stderrTrimmed && stdoutTrimmed) parts.push(stdoutTrimmed);
  if (data.logs.length > 0) parts.push(`log output:\n${data.logs.join("\n")}`);
  if (runDir) parts.push(`run dir: ${runDir}`);
  // Redact the assembled failure text once so every part — step detail, raw
  // streams, and logs — passes the same boundary regardless of which branch
  // contributed it.
  return {
    text: capBytes(redactCredentials(parts.join("\n\n"), env), caps.resultText),
    isError: true,
    runDir,
    exitStatus: exit.status,
    signal: exit.signal,
  };
}

function readMetaFile(metaFile: string): { runDir?: string; summaryFile?: string } {
  if (!existsSync(metaFile)) return {};
  const out: { runDir?: string; summaryFile?: string } = {};
  for (const line of readFileSync(metaFile, "utf8").split(/\r?\n/)) {
    if (line.startsWith("run_dir=")) {
      const value = line.slice("run_dir=".length).trim();
      if (value) out.runDir = value;
    }
    if (line.startsWith("summary_file=")) {
      const value = line.slice("summary_file=".length).trim();
      if (value) out.summaryFile = value;
    }
  }
  return out;
}

/**
 * Read a run's `return_value.txt`. In Docker mode `runDir` is discovered from
 * the host-side sandbox runs mount, so `remapContainerPath` normalizes any
 * container-internal prefix to the host path before reading.
 */
function readReturnValue(runDir: string | undefined, sandboxRunDir: string | undefined): string | undefined {
  if (!runDir) return undefined;
  const candidate = sandboxRunDir
    ? remapContainerPath(join(runDir, "return_value.txt"), sandboxRunDir)
    : join(runDir, "return_value.txt");
  if (!existsSync(candidate)) return undefined;
  try {
    return readFileSync(candidate, "utf8");
  } catch {
    return undefined;
  }
}

function trimTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
