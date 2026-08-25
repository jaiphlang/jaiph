import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { errText } from "../../errors";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { basename } from "node:path";
import { parsejaiph } from "../../parser";
import {
  buildScripts,
  buildScriptsFromGraph,
  loadModuleGraph,
  writeModuleGraph,
} from "../../transpiler";
import { canUseAnsi, CHAIN_KEY_ENV, generateChainKey, writeChainKey } from "../../runtime";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import { buildStepDisplayParamPairs, formatNamedParamsForDisplay } from "../shared/format-params.js";
import {
  colorPalette,
  resolveFailureDetails,
  hasFatalRuntimeStderr,
  latestRunFiles,
  failedStepArtifactPaths,
  formatRunTimeoutMessage,
} from "../shared/errors";
import { readMetaFields, readReturnValue } from "../shared/run-meta";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs } from "../shared/usage";

const RUN_USAGE =
  "Usage: jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh> [--] [args...]\n\n" +
  "Parse, validate, and run a Jaiph workflow file. Requires a `workflow default` entrypoint.\n\n" +
  "  --target <dir>     keep emitted scripts and run metadata under <dir>\n" +
  "  --raw              skip banner, progress tree, hooks, and failure footer; inherited stdio\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect from the .jh file)\n" +
  "  --env KEY=VALUE    define KEY=VALUE in the workflow env (repeatable); --env KEY forwards the host value\n" +
  "  --                 end of jaiph flags; remaining args go to workflow default\n" +
  "  -h, --help         show this help\n\n" +
  "Examples:\n" +
  "  jaiph run ./flows/review.jh \"review this diff\"\n" +
  "  jaiph run --workspace ./app ./flows/fix.jh\n";
import {
  spawnRunProcess,
  setupRunSignalHandlers,
  waitForRunExit,
  armRunTimeout,
  parseRunTimeoutSeconds,
} from "../run/lifecycle";
import {
  styleKeywordLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
} from "../run/progress";
import { loadMergedHooks, registerHooksSubscriber, isProjectHooksTrusted } from "../run/hooks";
import { resolveRuntimeEnv, resolveEnvPairs } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import { planTrustedEnvs } from "../run/trusted-envs";
import { colorize, formatJaiphRunningBannerLines } from "../run/display";
import { createRunEmitter } from "../run/emitter";
import { exportRunTelemetry } from "../telemetry/otlp";
import {
  createStderrParser,
  createRunState,
  registerStateSubscriber,
  registerTTYSubscriber,
  tickNonTTYHeartbeat,
  nonTTYHeartbeatTickMs,
  type TTYContext,
} from "../run/stderr-handler";

export async function runWorkflow(rest: string[]): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(RUN_USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest, "run");
  } catch (err) {
    return failWith(err);
  }
  const { target, raw, workspace, env, positional } = parsed;
  const input = positional[0];
  const runArgs = positional.slice(1);
  if (!input) {
    process.stderr.write("jaiph run requires a .jh file path\n");
    return 1;
  }
  let extraEnv: Record<string, string>;
  try {
    extraEnv = resolveEnvPairs(env, process.env);
  } catch (err) {
    return failWith(err);
  }
  const inputAbs = resolve(input);
  const workspaceRoot = workspace ? resolve(workspace) : detectWorkspaceRoot(dirname(inputAbs));
  if (workspace) {
    if (!existsSync(workspaceRoot)) {
      process.stderr.write(`--workspace path does not exist: ${workspaceRoot}\n`);
      return 1;
    }
    if (!statSync(workspaceRoot).isDirectory()) {
      process.stderr.write(`--workspace path is not a directory: ${workspaceRoot}\n`);
      return 1;
    }
  }
  const inputStat = statSync(inputAbs);
  const ext = extname(inputAbs);
  if (!inputStat.isFile() || ext !== ".jh") {
    process.stderr.write("jaiph run expects a single .jh file\n");
    return 1;
  }

  if (raw) {
    return runWorkflowRaw(inputAbs, workspaceRoot, target, runArgs, extraEnv);
  }

  const hooksConfig = loadMergedHooks(workspaceRoot, isProjectHooksTrusted(process.env));
  const graph = loadModuleGraph(inputAbs, workspaceRoot);
  const mod = graph.modules.get(inputAbs)!.ast;
  const resolvedModuleMetadata = resolveModuleMetadata(mod, process.env);
  const effectiveConfig = metadataToConfig(resolvedModuleMetadata);

  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const colorEnabled = canUseAnsi();
    const isTTY = !!process.stdout.isTTY;
    const startedAt = Date.now();

    const runtimeEnv = resolveRuntimeEnv(effectiveConfig, workspaceRoot, inputAbs);
    runtimeEnv.JAIPH_SOURCE_ABS = inputAbs;
    const runId = randomUUID();
    runtimeEnv.JAIPH_RUN_ID = runId;
    // Per-run audit-chain key: generated host-side, forwarded to the trusted
    // runner, scrubbed from every script/agent subprocess env, and persisted
    // beside the journal after the run so read/export boundaries can verify it.
    const chainKey = generateChainKey();
    runtimeEnv[CHAIN_KEY_ENV] = chainKey;
    Object.assign(runtimeEnv, extraEnv);
    const credPreflight = preflightAgentCredentials({
      mod,
      inputAbs,
      runtimeEnv,
    });
    if (reportPreflight(credPreflight.warnings, credPreflight.errors)) return 1;
    const trustedPlan = planTrustedEnvs(graph, extraEnv, process.env);
    if (reportPreflight(trustedPlan.warnings, trustedPlan.errors)) return 1;

    process.stdout.write(formatJaiphRunningBannerLines(basename(inputAbs)));

    const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
    runtimeEnv.JAIPH_SCRIPTS = scriptsDir;
    const graphFile = join(outDir, ".jaiph-module-graph.json");
    writeModuleGraph(graphFile, graph);
    runtimeEnv.JAIPH_MODULE_GRAPH_FILE = graphFile;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);

    const emitter = createRunEmitter();
    const runState = createRunState();
    const ttyCtx: TTYContext = {
      isTTY,
      colorEnabled,
      startedAt,
      runningInterval: undefined,
      nonTTYHeartbeatInterval: undefined,
      nonTTYHeartbeatStep: null,
    };

    registerStateSubscriber(emitter, runState);
    registerTTYSubscriber(emitter, ttyCtx);
    registerHooksSubscriber(emitter, hooksConfig, inputAbs, workspaceRoot);

    writeWorkflowRootLabel(mod, runArgs, colorEnabled, isTTY, startedAt);

    emitter.emit("workflow_start", {
      event: "workflow_start",
      workflow_id: runId,
      timestamp: new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
    });

    Object.assign(runtimeEnv, trustedPlan.resolved, extraEnv);
    const execResult = spawnHostRun(runtimeEnv, outDir, workspaceRoot, metaFile, "default", runArgs);

    const signalHandlers = setupRunSignalHandlers(execResult, {
      forceKillAfterMs: 1500,
    });
    const hostRunTimeoutSec = parseRunTimeoutSeconds(runtimeEnv);
    const runTimeout = armRunTimeout(execResult, hostRunTimeoutSec, {
      onTimeout: () => {
        runState.capturedStderr += `${formatRunTimeoutMessage(hostRunTimeoutSec)}\n`;
      },
    });
    if (isTTY) {
      ttyCtx.runningInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        process.stdout.write("\r" + formatRunningBottomLine("default", elapsedSec) + "\u001b[K");
      }, 1000);
    } else {
      const hbMs = nonTTYHeartbeatTickMs();
      ttyCtx.nonTTYHeartbeatInterval = setInterval(() => {
        tickNonTTYHeartbeat(ttyCtx);
      }, hbMs);
    }

    const onLine = createStderrParser(emitter);
    const buf: StreamBuffers = { stdout: "", stderr: "" };

    wireStreams(execResult, onLine, buf, ttyCtx);
    const childExit = await waitForRunExit(execResult, () => signalHandlers.remove());
    drainBuffers(onLine, buf, ttyCtx);

    runTimeout.cancel();
    if (childExit.signal && runState.capturedStderr.trim().length === 0) {
      runState.capturedStderr = `Process terminated by signal ${childExit.signal}`;
    }

    if (ttyCtx.runningInterval !== undefined) {
      clearInterval(ttyCtx.runningInterval);
      ttyCtx.runningInterval = undefined;
      process.stdout.write("\r\u001b[K");
    }
    if (ttyCtx.nonTTYHeartbeatInterval !== undefined) {
      clearInterval(ttyCtx.nonTTYHeartbeatInterval);
      ttyCtx.nonTTYHeartbeatInterval = undefined;
    }

    return await reportResult(
      runState.capturedStderr, childExit.status, childExit.signal, startedAt, runtimeEnv,
      emitter, runState.workflowRunId, inputAbs, workspaceRoot, metaFile,
      chainKey,
    );
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

/**
 * Raw mode: skip banner, tree, hooks, and failure footer. Inherited stdio so
 * `__JAIPH_EVENT__` lines flow to the caller. Used for embedding.
 */
async function runWorkflowRaw(
  inputAbs: string,
  workspaceRoot: string,
  target: string | undefined,
  runArgs: string[],
  extraEnv: Record<string, string>,
): Promise<number> {
  const mod = parsejaiph(readFileSync(inputAbs, "utf8"), inputAbs);
  const resolvedModuleMetadata = resolveModuleMetadata(mod, process.env);
  const effectiveConfig = metadataToConfig(resolvedModuleMetadata);
  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const runtimeEnv = resolveRuntimeEnv(effectiveConfig, workspaceRoot, inputAbs);
    runtimeEnv.JAIPH_SOURCE_ABS = inputAbs;
    const chainKey = runtimeEnv[CHAIN_KEY_ENV] ?? generateChainKey();
    runtimeEnv[CHAIN_KEY_ENV] = chainKey;
    Object.assign(runtimeEnv, extraEnv);
    const { scriptsDir } = buildScripts(inputAbs, outDir, workspaceRoot);
    runtimeEnv.JAIPH_SCRIPTS = scriptsDir;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);

    const dummyBuiltPath = join(outDir, "entry.sh");
    const workflowSymbol = "default";
    const execResult = spawnRunProcess(
      [metaFile, dummyBuiltPath, workflowSymbol, ...runArgs],
      { cwd: workspaceRoot, env: runtimeEnv, stdio: "inherit" },
    );

    const childExit = await waitForRunExit(execResult);
    const rawRunDir = readRunDirFromMeta(metaFile);
    if (rawRunDir) writeChainKey(rawRunDir, chainKey);
    await exportRunTelemetry({
      runDir: rawRunDir,
      workflow: workflowSymbol,
      exitStatus: childExit.status,
      signal: childExit.signal,
      env: process.env,
    });
    return childExit.status;
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

/** Write an error's message to stderr and return exit code 1. */
function failWith(err: unknown): 1 {
  process.stderr.write(`${errText(err)}\n`);
  return 1;
}

/** Print preflight warnings, then errors; returns true when the errors mean the run must abort. */
function reportPreflight(warnings: string[], errors: string[]): boolean {
  for (const w of warnings) {
    process.stderr.write(`${w}\n`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`${e}\n`);
    }
    return true;
  }
  return false;
}

/** Read `run_dir=` from a runner meta file; undefined when absent/unwritten. */
function readRunDirFromMeta(metaFile: string): string | undefined {
  return readMetaFields(metaFile, ["run_dir"]).run_dir;
}

function writeWorkflowRootLabel(
  mod: ReturnType<typeof parsejaiph>,
  runArgs: string[],
  colorEnabled: boolean,
  isTTY: boolean,
  startedAt: number,
): void {
  const rootLabel = "workflow default";
  const defaultWf = mod.workflows.find((w) => w.name === "default");
  const rootParamsSuffix =
    runArgs.length > 0
      ? colorize(
          formatNamedParamsForDisplay(
            buildStepDisplayParamPairs(runArgs, defaultWf?.params, { positionalStyle: "numeric" }),
          ),
          "dim",
          colorEnabled,
        )
      : "";
  process.stdout.write(`${styleKeywordLabel(rootLabel)}${rootParamsSuffix}\n`);
  if (isTTY) {
    process.stdout.write("\n" + formatRunningBottomLine("default", 0));
  }
}

function spawnHostRun(
  runtimeEnv: Record<string, string | undefined>,
  outDir: string,
  workspaceRoot: string,
  metaFile: string,
  workflowSymbol: string,
  runArgs: string[],
): ReturnType<typeof spawnRunProcess> {
  const dummyBuiltPath = join(outDir, "entry.sh");
  return spawnRunProcess([metaFile, dummyBuiltPath, workflowSymbol, ...runArgs], {
    cwd: workspaceRoot,
    env: runtimeEnv,
  });
}

type StreamBuffers = { stdout: string; stderr: string };

function wireStreams(
  execResult: ReturnType<typeof spawnRunProcess>,
  onLine: (line: string) => void,
  buf: StreamBuffers,
  ttyCtx: TTYContext,
): void {
  execResult.stdout?.setEncoding("utf8");
  execResult.stderr?.setEncoding("utf8");

  execResult.stdout?.on("data", (chunk: string) => {
    writePlainStdout(chunk, ttyCtx);
  });

  execResult.stderr?.on("data", (chunk: string) => {
    buf.stderr += chunk;
    let idx = buf.stderr.indexOf("\n");
    while (idx !== -1) {
      const line = buf.stderr.slice(0, idx).replace(/\r$/, "");
      buf.stderr = buf.stderr.slice(idx + 1);
      onLine(line);
      idx = buf.stderr.indexOf("\n");
    }
  });
}

function drainBuffers(
  onLine: (line: string) => void,
  buf: StreamBuffers,
  ttyCtx: TTYContext,
): void {
  if (buf.stdout.length > 0) {
    const remaining = buf.stdout.replace(/\r$/, "").split(/\r?\n/);
    for (const line of remaining) {
      if (line.length > 0) {
        writePlainStdout(`${line}\n`, ttyCtx);
      }
    }
    buf.stdout = "";
  }
  if (buf.stderr.length > 0) {
    const remaining = buf.stderr.replace(/\r$/, "").split(/\r?\n/);
    for (const line of remaining) {
      if (line.length > 0) onLine(line);
    }
    buf.stderr = "";
  }
}

function clearTTYBottomLine(ttyCtx: TTYContext): void {
  if (ttyCtx.isTTY && ttyCtx.runningInterval !== undefined) {
    process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
  }
}

function redrawTTYBottomLine(ttyCtx: TTYContext): void {
  if (ttyCtx.isTTY && ttyCtx.runningInterval !== undefined) {
    const elapsedSec = (Date.now() - ttyCtx.startedAt) / 1000;
    process.stdout.write(formatRunningBottomLine("default", elapsedSec));
  }
}

function writePlainStdout(chunk: string, ttyCtx: TTYContext): void {
  clearTTYBottomLine(ttyCtx);
  process.stdout.write(chunk);
  redrawTTYBottomLine(ttyCtx);
}

async function reportResult(
  capturedStderr: string,
  exitStatus: number,
  signal: NodeJS.Signals | null,
  startedAt: number,
  runtimeEnv: Record<string, string | undefined>,
  emitter: ReturnType<typeof createRunEmitter>,
  workflowRunId: string,
  inputAbs: string,
  workspaceRoot: string,
  metaFile: string,
  chainKey?: string,
): Promise<number> {
  const elapsedMs = Date.now() - startedAt;
  const elapsedLabel = formatElapsedDuration(elapsedMs);
  const metaFields = readMetaFields(metaFile, ["run_dir", "summary_file"]);
  const runDir: string | undefined = metaFields.run_dir;
  const summaryFile: string | undefined = metaFields.summary_file;
  if (runDir && chainKey) writeChainKey(runDir, chainKey);
  await exportRunTelemetry({ runDir, workflow: "default", exitStatus, signal, env: process.env });
  const runtimeDebugEnabled = runtimeEnv.JAIPH_DEBUG === "true";
  const runtimeErrorPrinted = hasFatalRuntimeStderr(capturedStderr, runtimeDebugEnabled);
  const resolvedStatus = exitStatus !== 0 || runtimeErrorPrinted ? 1 : 0;

  emitter.emit("workflow_end", {
    event: "workflow_end",
    workflow_id: workflowRunId,
    status: resolvedStatus,
    elapsed_ms: elapsedMs,
    timestamp: new Date().toISOString(),
    run_path: inputAbs,
    workspace: workspaceRoot,
    run_dir: runDir,
    summary_file: summaryFile,
  });

  const palette = colorPalette();
  if (resolvedStatus === 0) {
    // Match TTY spacing: tree lines use double newlines between rows; non-TTY uses single `\n` per row.
    const passPrefix = process.stdout.isTTY ? "" : "\n";
    process.stdout.write(
      `${passPrefix}${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedLabel})${palette.reset}\n`,
    );
    // Print workflow return value (if any) on its own line, separated by a blank line.
    // The runtime writes return_value.txt only when the default workflow returns a value.
    const returnValue = readReturnValue(runDir);
    if (returnValue !== undefined && returnValue.length > 0) {
      const trimmed = returnValue.endsWith("\n") ? returnValue.slice(0, -1) : returnValue;
      process.stdout.write(`\n${trimmed}\n`);
    }
    return 0;
  }

  const failureDetails = resolveFailureDetails(capturedStderr, summaryFile, {
    code: exitStatus,
    runDir,
  });
  process.stderr.write("\n");
  process.stderr.write(
    `${palette.red}\u2717 FAIL${palette.reset} workflow default ${palette.dim}(${elapsedLabel})${palette.reset}\n`,
  );
  if (failureDetails.shouldPrintSummaryLine) {
    process.stderr.write(`  ${failureDetails.summary}\n`);
  }
  if (runDir) {
    process.stderr.write(`  Logs: ${runDir}\n`);
    if (summaryFile) {
      process.stderr.write(`  Summary: ${summaryFile}\n`);
    }
    const fromSummary = summaryFile ? failedStepArtifactPaths(summaryFile) : {};
    const files =
      fromSummary.out !== undefined || fromSummary.err !== undefined
        ? { out: fromSummary.out, err: fromSummary.err }
        : latestRunFiles(runDir);
    if (files.out) process.stderr.write(`    out: ${files.out}\n`);
    if (files.err) process.stderr.write(`    err: ${files.err}\n`);
    if (failureDetails.failedStepOutput) {
      process.stderr.write("\n  Output of failed step:\n");
      for (const line of failureDetails.failedStepOutput.split("\n")) {
        process.stderr.write(`    ${line}\n`);
      }
    }
  }

  return resolvedStatus;
}

