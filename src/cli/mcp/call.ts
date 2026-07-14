import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { JaiphConfig } from "../../config";
import { spawnRunProcess, waitForRunExit } from "../run/lifecycle";
import { resolveRuntimeEnv } from "../run/env";
import { parseLogEvent, parseStepEvent } from "../run/events";
import type { McpCallResult } from "./server";

/**
 * Everything a `tools/call` needs from the server session. Built once per
 * module-graph generation (startup and each hot reload) — scripts and the
 * serialized graph are read-only, so concurrent calls can share them.
 */
export interface McpCallEnvironment {
  inputAbs: string;
  workspaceRoot: string;
  effectiveConfig: JaiphConfig;
  /** Emitted scripts dir for this generation (`buildScriptsFromGraph`). */
  scriptsDir: string;
  /** Serialized module graph consumed by the spawned runner. */
  graphFile: string;
  /** Generation dir for per-call meta files. */
  outDir: string;
  /**
   * Resolved `--env` passthrough applied to every tool call's runner env for
   * the server's lifetime (host execution). Once Docker-backed MCP calls
   * exist, these must flow through `DockerSpawnOptions.extraEnv` — this is the
   * single choke point.
   */
  extraEnv: Record<string, string>;
}

/**
 * Execute one workflow as an MCP tool call: spawn the workflow runner (host
 * execution, like `jaiph run --raw` — the Docker sandbox is not launched),
 * capture `__JAIPH_EVENT__` lines from stderr, and compose the result text.
 *
 * Success text, in order of preference: the workflow's return value
 * (`return_value.txt`), collected `log` output, or a completion note.
 */
export async function callWorkflow(
  env: McpCallEnvironment,
  workflowSymbol: string,
  positionalArgs: string[],
): Promise<McpCallResult> {
  const runtimeEnv = resolveRuntimeEnv(env.effectiveConfig, env.workspaceRoot, env.inputAbs);
  const runId = randomUUID();
  runtimeEnv.JAIPH_SOURCE_ABS = env.inputAbs;
  runtimeEnv.JAIPH_RUN_ID = runId;
  runtimeEnv.JAIPH_SCRIPTS = env.scriptsDir;
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

  const logs: string[] = [];
  let failedStep: { name: string; detail: string } | undefined;
  let rawStderr = "";
  let rawStdout = "";

  const onStderrLine = (line: string): void => {
    const logEvent = parseLogEvent(line);
    if (logEvent) {
      logs.push(logEvent.message);
      return;
    }
    const stepEvent = parseStepEvent(line);
    if (stepEvent) {
      if (stepEvent.type === "STEP_END" && stepEvent.status !== null && stepEvent.status !== 0 && !failedStep) {
        const detail = stepEvent.err_content.trim() || stepEvent.out_content.trim();
        failedStep = { name: `${stepEvent.kind} ${stepEvent.name}`.trim(), detail };
      }
      return;
    }
    rawStderr += `${line}\n`;
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
    rawStdout += chunk;
  });

  const exit = await waitForRunExit(child);
  if (stderrBuf.length > 0) onStderrLine(stderrBuf.replace(/\r$/, ""));

  const meta = readMetaFile(metaFile);
  const failed = exit.status !== 0 || exit.signal !== null;

  if (!failed) {
    const returnValue = readReturnValue(meta.runDir);
    const text =
      returnValue !== undefined && returnValue.length > 0
        ? returnValue
        : logs.length > 0
          ? logs.join("\n")
          : `workflow ${workflowSymbol} completed`;
    return { text: trimTrailingNewline(text), isError: false };
  }

  const parts: string[] = [];
  parts.push(
    exit.signal
      ? `workflow ${workflowSymbol} terminated by signal ${exit.signal}`
      : `workflow ${workflowSymbol} failed (exit ${exit.status})`,
  );
  if (failedStep) {
    parts.push(`failed step: ${failedStep.name}`);
    if (failedStep.detail) parts.push(failedStep.detail);
  }
  const stderrTrimmed = rawStderr.trim();
  if (stderrTrimmed) parts.push(stderrTrimmed);
  const stdoutTrimmed = rawStdout.trim();
  if (!failedStep && !stderrTrimmed && stdoutTrimmed) parts.push(stdoutTrimmed);
  if (logs.length > 0) parts.push(`log output:\n${logs.join("\n")}`);
  if (meta.runDir) parts.push(`run dir: ${meta.runDir}`);
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

function readReturnValue(runDir: string | undefined): string | undefined {
  if (!runDir) return undefined;
  const candidate = join(runDir, "return_value.txt");
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
