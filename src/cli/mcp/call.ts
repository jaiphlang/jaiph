import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import type { McpCallResult, McpCallContext } from "./server";

/**
 * Everything a `tools/call` needs from the server session. Built once per
 * module-graph generation (startup and each hot reload) — scripts and the
 * serialized graph are read-only, so concurrent calls can share them.
 */
export interface McpCallEnvironment {
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
   * Resolved `--env` passthrough applied to every tool call for the server's
   * lifetime. Host execution merges it into the runner env; Docker execution
   * threads it through `DockerSpawnOptions.extraEnv` — this is the single
   * choke point either way.
   */
  extraEnv: Record<string, string>;
}

/** Output accumulated from a run child's streams while it executes. */
interface CollectedOutput {
  logs: string[];
  failedStep?: { name: string; detail: string };
  rawStderr: string;
  rawStdout: string;
}

/**
 * Execute one workflow as an MCP tool call. Honors the same env-driven sandbox
 * selection as `jaiph run`: when `dockerConfig.enabled`, the call runs in a
 * per-call container (workspace isolated by default; inplace when JAIPH_INPLACE=1);
 * otherwise it runs on the host like `jaiph run --raw`.
 *
 * Success text, in order of preference: the workflow's return value
 * (`return_value.txt`), collected `log` output, or a completion note.
 */
export async function callWorkflow(
  env: McpCallEnvironment,
  dockerConfig: DockerRunConfig,
  workflowSymbol: string,
  positionalArgs: string[],
  ctx?: McpCallContext,
): Promise<McpCallResult> {
  const runtimeEnv = resolveRuntimeEnv(env.effectiveConfig, env.workspaceRoot, env.inputAbs);
  const runId = randomUUID();
  runtimeEnv.JAIPH_SOURCE_ABS = env.inputAbs;
  runtimeEnv.JAIPH_RUN_ID = runId;
  runtimeEnv.JAIPH_SCRIPTS = env.scriptsDir;

  if (dockerConfig.enabled) {
    return callWorkflowDocker(env, dockerConfig, workflowSymbol, positionalArgs, runtimeEnv, runId, ctx);
  }
  return callWorkflowHost(env, workflowSymbol, positionalArgs, runtimeEnv, runId, ctx);
}

/** Host execution — same self-spawn path as `jaiph run --raw`. */
async function callWorkflowHost(
  env: McpCallEnvironment,
  workflowSymbol: string,
  positionalArgs: string[],
  runtimeEnv: Record<string, string | undefined>,
  runId: string,
  ctx?: McpCallContext,
): Promise<McpCallResult> {
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
  const collector = attachOutputCollector(child, ctx?.onStep);
  const exit = await waitForRunExit(child);
  collector.drain();

  const meta = readMetaFile(metaFile);
  return composeResult(workflowSymbol, collector.data, exit, meta.runDir, undefined);
}

/**
 * Container execution — the same Docker path as `jaiph run`. The workflow
 * symbol is carried into the container so a non-`default` tool runs correctly.
 * Sandbox mode matches `jaiph run` (isolated by default; inplace when
 * JAIPH_INPLACE=1). The container meta file is inaccessible from the host, so
 * the run dir is discovered from the sandbox runs mount.
 */
async function callWorkflowDocker(
  env: McpCallEnvironment,
  dockerConfig: DockerRunConfig,
  workflowSymbol: string,
  positionalArgs: string[],
  runtimeEnv: Record<string, string | undefined>,
  runId: string,
  ctx?: McpCallContext,
): Promise<McpCallResult> {
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
  const collector = attachOutputCollector(dockerResult.child, ctx?.onStep);
  return withDockerExitGuard(dockerResult, async () => {
    const exit = await waitForRunExit(dockerResult.child);
    collector.drain();
    const discovered = discoverDockerRunDir(sandboxRunDir, runId);
    return composeResult(workflowSymbol, collector.data, exit, discovered.runDir, sandboxRunDir);
  });
}

/**
 * Attach line-oriented listeners to a run child's stderr/stdout. Parses
 * `__JAIPH_EVENT__` log/step lines from stderr (child stdout is captured but
 * never forwarded). `onStep` (when given) fires once per `STEP_START`/`STEP_END`
 * event so the caller can stream progress. `drain()` flushes any trailing
 * partial stderr line.
 */
function attachOutputCollector(
  child: ChildProcess,
  onStep?: (kind: string, name: string) => void,
): { data: CollectedOutput; drain: () => void } {
  const data: CollectedOutput = { logs: [], rawStderr: "", rawStdout: "" };
  const onStderrLine = (line: string): void => {
    const logEvent = parseLogEvent(line);
    if (logEvent) {
      data.logs.push(logEvent.message);
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
    data.rawStderr += `${line}\n`;
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
    data.rawStdout += chunk;
  });

  return {
    data,
    drain: (): void => {
      if (stderrBuf.length > 0) onStderrLine(stderrBuf.replace(/\r$/, ""));
    },
  };
}

/** Compose the MCP result text from a finished run's output + run dir. */
function composeResult(
  workflowSymbol: string,
  data: CollectedOutput,
  exit: { status: number; signal: NodeJS.Signals | null },
  runDir: string | undefined,
  sandboxRunDir: string | undefined,
): McpCallResult {
  const failed = exit.status !== 0 || exit.signal !== null;

  if (!failed) {
    const returnValue = readReturnValue(runDir, sandboxRunDir);
    const text =
      returnValue !== undefined && returnValue.length > 0
        ? returnValue
        : data.logs.length > 0
          ? data.logs.join("\n")
          : `workflow ${workflowSymbol} completed`;
    return { text: trimTrailingNewline(text), isError: false };
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
  return { text: parts.join("\n\n"), isError: true };
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
