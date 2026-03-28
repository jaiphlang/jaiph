import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { basename } from "node:path";
import { parsejaiph } from "../../parser";
import { build, workflowSymbolForFile } from "../../transpiler";
import { metadataToConfig } from "../../config";
import { formatNamedParamsForDisplay } from "./format-params.js";
import {
  colorPalette,
  resolveFailureDetails,
  hasFatalRuntimeStderr,
  latestRunFiles,
  failedStepArtifactPaths,
} from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";
import type { SourceMapCache } from "../shared/jaiph-source-map";
import { parseArgs } from "../shared/usage";
import { parseLogEvent, parseStepEvent } from "../run/events";
import {
  spawnRunProcess,
  setupRunSignalHandlers,
  waitForRunExit,
} from "../run/lifecycle";
import {
  resolveDockerConfig,
  spawnDockerProcess,
  cleanupDocker,
} from "../../runtime/docker";
import {
  styleKeywordLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
} from "../run/progress";
import { loadMergedHooks, registerHooksSubscriber } from "../run/hooks";
import { resolveRuntimeEnv } from "../run/env";
import { colorize } from "../run/display";
import { createRunEmitter } from "../run/emitter";
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
  const { target, positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);
  if (!input) {
    process.stderr.write("jaiph run requires a .jh file path\n");
    return 1;
  }
  const inputAbs = resolve(input);
  const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
  const hooksConfig = loadMergedHooks(workspaceRoot);
  const inputStat = statSync(inputAbs);
  const ext = extname(inputAbs);
  if (!inputStat.isFile() || ext !== ".jh") {
    process.stderr.write("jaiph run expects a single .jh file\n");
    return 1;
  }

  const mod = parsejaiph(readFileSync(inputAbs, "utf8"), inputAbs);
  const effectiveConfig = metadataToConfig(mod.metadata);

  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const results = build(inputAbs, outDir);
    if (results.length !== 1) {
      process.stderr.write(`jaiph run expected one built output, got ${results.length}\n`);
      return 1;
    }
    const builtPath = results[0].outputPath;
    const workflowSymbol = workflowSymbolForFile(inputAbs, dirname(inputAbs));
    const colorEnabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
    const isTTY = !!process.stdout.isTTY;
    const startedAt = Date.now();

    writeBanner(inputAbs, runArgs, colorEnabled, isTTY, startedAt);

    const runtimeEnv = resolveRuntimeEnv(effectiveConfig, workspaceRoot, inputAbs);
    runtimeEnv.JAIPH_SOURCE_ABS = inputAbs;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);

    // Set up event emitter and subscribers
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

    emitter.emit("workflow_start", {
      event: "workflow_start",
      workflow_id: "",
      timestamp: new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
    });

    const { execResult, dockerResult, dockerConfig } = spawnExec(
      mod, runtimeEnv, builtPath, outDir, workspaceRoot, metaFile, workflowSymbol, runArgs, isTTY,
    );

    const signalHandlers = setupRunSignalHandlers(execResult, { forceKillAfterMs: 1500 });

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

    const sourceMapCache: SourceMapCache = new Map();
    const onLine = createStderrParser(emitter, { sourceMapCache });
    const buf: StreamBuffers = { stdout: "", stderr: "" };

    wireStreams(execResult, dockerConfig.enabled, onLine, buf, ttyCtx);
    const childExit = await waitForRunExit(execResult, () => signalHandlers.remove());
    drainBuffers(dockerConfig.enabled, onLine, buf, ttyCtx);

    if (dockerResult) {
      const timedOut = dockerResult.timeoutTimer === undefined && dockerConfig.timeout > 0
        ? false
        : (Date.now() - startedAt) >= dockerConfig.timeout * 1000;
      cleanupDocker(dockerResult);
      if (timedOut && childExit.status !== 0) {
        runState.capturedStderr += "E_TIMEOUT container execution exceeded timeout\n";
      }
    }

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

    return reportResult(
      runState.capturedStderr, childExit.status, startedAt, runtimeEnv,
      emitter, runState.workflowRunId, inputAbs, workspaceRoot, metaFile,
    );
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

function writeBanner(
  inputAbs: string, runArgs: string[], colorEnabled: boolean, isTTY: boolean, startedAt: number,
): void {
  const rootLabel = "workflow default";
  process.stdout.write(`\nJaiph: Running ${basename(inputAbs)}\n\n`);
  const rootParamsSuffix =
    runArgs.length > 0
      ? colorize(formatNamedParamsForDisplay(runArgs.map((a, i) => [String(i + 1), a] as [string, string])), "dim", colorEnabled)
      : "";
  process.stdout.write(`${styleKeywordLabel(rootLabel)}${rootParamsSuffix}\n`);
  if (isTTY) {
    process.stdout.write("\n" + formatRunningBottomLine("default", 0));
  }
}

function spawnExec(
  mod: ReturnType<typeof parsejaiph>,
  runtimeEnv: Record<string, string | undefined>,
  builtPath: string,
  outDir: string,
  workspaceRoot: string,
  metaFile: string,
  workflowSymbol: string,
  runArgs: string[],
  isTTY: boolean,
): { execResult: ReturnType<typeof spawnRunProcess>; dockerResult: ReturnType<typeof spawnDockerProcess> | undefined; dockerConfig: ReturnType<typeof resolveDockerConfig> } {
  const dockerConfig = resolveDockerConfig(mod.metadata?.runtime, runtimeEnv);
  let dockerResult: ReturnType<typeof spawnDockerProcess> | undefined;
  let execResult;

  if (dockerConfig.enabled) {
    const stdlibPath = runtimeEnv.JAIPH_STDLIB ?? join(__dirname, "..", "..", "jaiph_stdlib.sh");
    dockerResult = spawnDockerProcess({
      config: dockerConfig,
      builtScriptPath: builtPath,
      stdlibPath,
      buildOutDir: outDir,
      workspaceRoot,
      metaFile,
      runArgs,
      env: runtimeEnv,
      isTTY,
    });
    execResult = dockerResult.child;
  } else {
    execResult = spawnRunProcess([metaFile, builtPath, workflowSymbol, ...runArgs], {
      cwd: workspaceRoot,
      env: runtimeEnv,
    });
  }
  return { execResult, dockerResult, dockerConfig };
}

type StreamBuffers = { stdout: string; stderr: string };

function wireStreams(
  execResult: ReturnType<typeof spawnRunProcess>,
  isDocker: boolean,
  onLine: (line: string) => void,
  buf: StreamBuffers,
  ttyCtx: TTYContext,
): void {
  execResult.stdout?.setEncoding("utf8");
  execResult.stderr?.setEncoding("utf8");

  if (isDocker) {
    execResult.stdout?.on("data", (chunk: string) => {
      buf.stdout += chunk;
      let idx = buf.stdout.indexOf("\n");
      while (idx !== -1) {
        const line = buf.stdout.slice(0, idx).replace(/\r$/, "");
        buf.stdout = buf.stdout.slice(idx + 1);
        if (parseLogEvent(line) || parseStepEvent(line)) {
          onLine(line);
        } else {
          writePlainStdout(`${line}\n`, ttyCtx);
        }
        idx = buf.stdout.indexOf("\n");
      }
    });
  } else {
    execResult.stdout?.on("data", (chunk: string) => {
      writePlainStdout(chunk, ttyCtx);
    });
  }

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
  isDocker: boolean,
  onLine: (line: string) => void,
  buf: StreamBuffers,
  ttyCtx: TTYContext,
): void {
  if (buf.stdout.length > 0) {
    const remaining = buf.stdout.replace(/\r$/, "").split(/\r?\n/);
    for (const line of remaining) {
      if (line.length > 0) {
        if (isDocker && (parseLogEvent(line) || parseStepEvent(line))) {
          onLine(line);
        } else {
          writePlainStdout(`${line}\n`, ttyCtx);
        }
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

function reportResult(
  capturedStderr: string,
  exitStatus: number,
  startedAt: number,
  runtimeEnv: Record<string, string | undefined>,
  emitter: ReturnType<typeof createRunEmitter>,
  workflowRunId: string,
  inputAbs: string,
  workspaceRoot: string,
  metaFile: string,
): number {
  const elapsedMs = Date.now() - startedAt;
  const elapsedLabel = formatElapsedDuration(elapsedMs);
  let runDir: string | undefined;
  let summaryFile: string | undefined;
  if (existsSync(metaFile)) {
    const metaLines = readFileSync(metaFile, "utf8").split(/\r?\n/);
    for (const line of metaLines) {
      if (line.startsWith("run_dir=")) {
        const value = line.slice("run_dir=".length).trim();
        if (value) runDir = value;
      }
      if (line.startsWith("summary_file=")) {
        const value = line.slice("summary_file=".length).trim();
        if (value) summaryFile = value;
      }
    }
  }
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
    process.stdout.write(
      `${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedLabel})${palette.reset}\n`,
    );
    return 0;
  }

  const failureDetails = resolveFailureDetails(capturedStderr, summaryFile);
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
