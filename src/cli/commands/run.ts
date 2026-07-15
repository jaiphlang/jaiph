import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { basename } from "node:path";
import { parsejaiph } from "../../parser";
import { buildScripts, buildScriptsFromGraph } from "../../transpiler";
import { loadModuleGraph, writeModuleGraph } from "../../transpile/module-graph";
import { canUseAnsi } from "../../runtime/kernel/portability";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import { buildStepDisplayParamPairs, formatNamedParamsForDisplay } from "./format-params.js";
import {
  colorPalette,
  resolveFailureDetails,
  hasFatalRuntimeStderr,
  latestRunFiles,
  failedStepArtifactPaths,
  discoverDockerRunDir,
  remapContainerPath,
  formatDockerTimeoutMessage,
} from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs } from "../shared/usage";

const RUN_USAGE =
  "Usage: jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] <file.jh> [--] [args...]\n\n" +
  "Parse, validate, and run a Jaiph workflow file. Requires a `workflow default` entrypoint.\n\n" +
  "  --target <dir>     keep emitted scripts and run metadata under <dir>\n" +
  "  --raw              skip banner, progress tree, hooks, and failure footer; inherited stdio\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect from the .jh file)\n" +
  "  --inplace          bind-mount the host workspace rw so edits land live (sets JAIPH_INPLACE=1 for this run)\n" +
  "  --unsafe           run on the host with no sandbox (sets JAIPH_UNSAFE=true for this run)\n" +
  "  -y, --yes          skip the in-place confirmation prompt (sets JAIPH_INPLACE_YES=1 for this run)\n" +
  "  --                 end of jaiph flags; remaining args go to workflow default\n" +
  "  -h, --help         show this help\n\n" +
  "Note: these flags only affect `jaiph run`; the corresponding env vars also apply to other entry points.\n\n" +
  "Examples:\n" +
  "  jaiph run ./flows/review.jh \"review this diff\"\n" +
  "  jaiph run --inplace --workspace ./app ./flows/fix.jh\n";
import {
  spawnRunProcess,
  setupRunSignalHandlers,
  waitForRunExit,
} from "../run/lifecycle";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  spawnDockerProcess,
  stopDockerRunOnSignal,
  withDockerExitGuard,
  resolveDockerHostRunsRoot,
  selectSandboxMode,
  RUN_WORKFLOW_ENV,
  type SandboxMode,
} from "../../runtime/docker";
import { confirmInplaceRun, confirmUnsafeRun } from "../../runtime/docker-inplace";
import {
  styleKeywordLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
} from "../run/progress";
import { loadMergedHooks, registerHooksSubscriber } from "../run/hooks";
import { resolveRuntimeEnv, applySandboxFlags, resolveEnvPairs } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import { colorize, formatJaiphRunningBannerLines } from "../run/display";
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
  if (hasHelpFlag(rest)) {
    process.stdout.write(RUN_USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { target, raw, workspace, inplace, unsafe, yes, env, positional } = parsed;
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
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
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

  const sandboxFlags = { inplace, unsafe, yes };
  if (raw) {
    return runWorkflowRaw(inputAbs, workspaceRoot, target, runArgs, sandboxFlags, extraEnv);
  }

  const hooksConfig = loadMergedHooks(workspaceRoot);
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
    try {
      applySandboxFlags(runtimeEnv, sandboxFlags);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const dockerConfigForBanner = resolveDockerConfig(resolvedModuleMetadata?.runtime, runtimeEnv);
    // Host modes: `--env` defines the workflow process's env directly,
    // overriding inherited values. Docker: the pairs cross the boundary as
    // explicit `-e` container args instead (threaded through `extraEnv`), so
    // they must not be pre-merged here (the allowlist would drop them).
    if (!dockerConfigForBanner.enabled) {
      Object.assign(runtimeEnv, extraEnv);
    }
    const credPreflight = preflightAgentCredentials({
      mod,
      inputAbs,
      runtimeEnv,
      dockerEnabled: dockerConfigForBanner.enabled,
    });
    for (const w of credPreflight.warnings) {
      process.stderr.write(`${w}\n`);
    }
    if (credPreflight.errors.length > 0) {
      for (const e of credPreflight.errors) {
        process.stderr.write(`${e}\n`);
      }
      return 1;
    }
    if (dockerConfigForBanner.enabled) {
      checkDockerAvailable();
      prepareImage(dockerConfigForBanner);
    }
    const sandboxModeForBanner = dockerConfigForBanner.enabled ? selectSandboxMode(runtimeEnv) : null;
    if (sandboxModeForBanner === "inplace") {
      const proceed = await confirmInplaceRun(workspaceRoot, runtimeEnv, isTTY);
      if (!proceed) {
        process.stderr.write("jaiph in-place mode: aborted by user.\n");
        return 1;
      }
    } else if (isUnsafeHostOnly(dockerConfigForBanner.enabled, runtimeEnv)) {
      // Docker is off *because* the user opted into unsafe (JAIPH_UNSAFE=true /
      // --unsafe) while Docker would otherwise be on — require the same consent
      // as in-place before running host-only with no sandbox. Not triggered when
      // Docker is off for another reason (win32 host-only override, which already
      // prints its own notice, or an explicit JAIPH_DOCKER_ENABLED=false).
      const proceed = await confirmUnsafeRun(workspaceRoot, runtimeEnv, isTTY);
      if (!proceed) {
        process.stderr.write("jaiph unsafe mode: aborted by user.\n");
        return 1;
      }
    }

    writeBanner(
      mod,
      inputAbs,
      runArgs,
      colorEnabled,
      isTTY,
      startedAt,
      dockerConfigForBanner.enabled,
      sandboxModeForBanner,
    );
    const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
    runtimeEnv.JAIPH_SCRIPTS = scriptsDir;
    // Serialized module graph consumed by the spawned runner so the runtime
    // graph reuses these ASTs instead of re-parsing every reachable module.
    // Docker mounts the workspace read-only, so place the cache under outDir,
    // which the host already arranges for the container side via its existing
    // sandbox layout. For local runs the runner reads the path directly.
    const graphFile = join(outDir, ".jaiph-module-graph.json");
    writeModuleGraph(graphFile, graph);
    if (!dockerConfigForBanner.enabled) {
      runtimeEnv.JAIPH_MODULE_GRAPH_FILE = graphFile;
    }
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

    emitter.emit("workflow_start", {
      event: "workflow_start",
      workflow_id: "",
      timestamp: new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
    });

    const { execResult, dockerResult, dockerConfig: activeDockerConfig } = spawnExec(
      mod, runtimeEnv, outDir, workspaceRoot, metaFile, "default", runArgs, isTTY, extraEnv,
    );

    // On interrupt, stop+remove the container (docker run --rm can outlive its
    // killed client) before removing the host sandbox clone.
    const onSignalCleanup = dockerResult ? () => stopDockerRunOnSignal(dockerResult) : undefined;
    const signalHandlers = setupRunSignalHandlers(execResult, {
      forceKillAfterMs: 1500,
      onSignalCleanup,
    });
    const childExit = await withDockerExitGuard(dockerResult, async () => {
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
      const exit = await waitForRunExit(execResult, () => signalHandlers.remove());
      drainBuffers(onLine, buf, ttyCtx);

      if (dockerResult) {
        const timedOut = dockerResult.timeoutTimer === undefined && activeDockerConfig.timeoutSeconds > 0
          ? false
          : (Date.now() - startedAt) >= activeDockerConfig.timeoutSeconds * 1000;
        if (timedOut && exit.status !== 0) {
          runState.capturedStderr += `${formatDockerTimeoutMessage(activeDockerConfig.timeoutSeconds)}\n`;
        }
      }
      return exit;
    });

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
      dockerResult?.sandboxRunDir, runId,
    );
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

/**
 * True when Docker is off specifically because the user opted into unsafe mode
 * (`JAIPH_UNSAFE=true` / `--unsafe`) while Docker would otherwise be on.
 *
 * "Would otherwise be on" is the key gate: it excludes win32 (forced host-only
 * with its own notice) and an explicit `JAIPH_DOCKER_ENABLED=false` (Docker
 * disabled by config, not by the unsafe opt-in). Only the unsafe-driven case
 * gets the extra host-only confirmation.
 */
function isUnsafeHostOnly(
  dockerEnabled: boolean,
  env: Record<string, string | undefined>,
): boolean {
  return (
    !dockerEnabled &&
    process.platform !== "win32" &&
    env.JAIPH_DOCKER_ENABLED === undefined &&
    env.JAIPH_UNSAFE === "true"
  );
}

/**
 * Raw mode: transparent passthrough for Docker sandbox.
 * Parses and compiles the workflow, spawns the runtime with inherited stdio
 * so __JAIPH_EVENT__ lines flow directly to stderr for the host CLI to render.
 * No banner, no tree rendering, no reportResult.
 */
async function runWorkflowRaw(
  inputAbs: string,
  workspaceRoot: string,
  target: string | undefined,
  runArgs: string[],
  sandboxFlags: { inplace?: boolean; unsafe?: boolean; yes?: boolean },
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
    try {
      applySandboxFlags(runtimeEnv, sandboxFlags);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    // Raw mode runs host-only (used for embedding and the Docker inner run);
    // `--env` defines the workflow process's env directly.
    Object.assign(runtimeEnv, extraEnv);
    const { scriptsDir } = buildScripts(inputAbs, outDir, workspaceRoot);
    runtimeEnv.JAIPH_SCRIPTS = scriptsDir;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);

    const dummyBuiltPath = join(outDir, "entry.sh");
    // Raw mode is the Docker container's inner entrypoint. It runs `default`
    // unless a non-default root symbol is carried in via JAIPH_RUN_WORKFLOW
    // (set by the Docker MCP call path through DockerSpawnOptions.workflowSymbol).
    const workflowSymbol = process.env[RUN_WORKFLOW_ENV] || "default";
    const execResult = spawnRunProcess(
      [metaFile, dummyBuiltPath, workflowSymbol, ...runArgs],
      { cwd: workspaceRoot, env: runtimeEnv, stdio: "inherit" },
    );

    const childExit = await waitForRunExit(execResult);
    return childExit.status;
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

function writeBanner(
  mod: ReturnType<typeof parsejaiph>,
  inputAbs: string,
  runArgs: string[],
  colorEnabled: boolean,
  isTTY: boolean,
  startedAt: number,
  dockerEnabled: boolean,
  sandboxMode: SandboxMode | null,
): void {
  const rootLabel = "workflow default";
  process.stdout.write(
    formatJaiphRunningBannerLines(basename(inputAbs), dockerEnabled, sandboxMode, colorEnabled),
  );
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

function spawnExec(
  mod: ReturnType<typeof parsejaiph>,
  runtimeEnv: Record<string, string | undefined>,
  outDir: string,
  workspaceRoot: string,
  metaFile: string,
  workflowSymbol: string,
  runArgs: string[],
  isTTY: boolean,
  extraEnv: Record<string, string>,
): { execResult: ReturnType<typeof spawnRunProcess>; dockerResult: ReturnType<typeof spawnDockerProcess> | undefined; dockerConfig: ReturnType<typeof resolveDockerConfig> } {
  const resolvedMetadata = resolveModuleMetadata(mod, runtimeEnv);
  const dockerConfig = resolveDockerConfig(resolvedMetadata?.runtime, runtimeEnv);
  let dockerResult: ReturnType<typeof spawnDockerProcess> | undefined;
  let execResult;

  if (dockerConfig.enabled) {
    const sandboxRunDir = resolveDockerHostRunsRoot(workspaceRoot, runtimeEnv);
    dockerResult = spawnDockerProcess({
      config: dockerConfig,
      sourceAbs: runtimeEnv.JAIPH_SOURCE_ABS!,
      workspaceRoot,
      sandboxRunDir,
      runArgs,
      env: runtimeEnv,
      extraEnv,
      isTTY,
    });
    execResult = dockerResult.child;
  } else {
    const dummyBuiltPath = join(outDir, "entry.sh");
    execResult = spawnRunProcess([metaFile, dummyBuiltPath, workflowSymbol, ...runArgs], {
      cwd: workspaceRoot,
      env: runtimeEnv,
    });
  }
  return { execResult, dockerResult, dockerConfig };
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
  sandboxRunDir?: string,
  expectedRunId?: string,
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
  // Docker mode: container meta file is inaccessible from host.
  // Discover the run directory from the bind-mounted sandbox runs dir.
  if (!runDir && sandboxRunDir && expectedRunId) {
    const discovered = discoverDockerRunDir(sandboxRunDir, expectedRunId);
    runDir = discovered.runDir;
    summaryFile = discovered.summaryFile;
  }
  const runtimeDebugEnabled = runtimeEnv.JAIPH_DEBUG === "true";
  const runtimeErrorPrinted = sandboxRunDir
    ? false
    : hasFatalRuntimeStderr(capturedStderr, runtimeDebugEnabled);
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
    const returnValue = readWorkflowReturnValue(runDir, sandboxRunDir);
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
    const remap = (p: string) => sandboxRunDir ? remapContainerPath(p, sandboxRunDir) : p;
    const files =
      fromSummary.out !== undefined || fromSummary.err !== undefined
        ? { out: fromSummary.out ? remap(fromSummary.out) : undefined, err: fromSummary.err ? remap(fromSummary.err) : undefined }
        : latestRunFiles(runDir);
    if (files.out) process.stderr.write(`    out: ${files.out}\n`);
    if (files.err) process.stderr.write(`    err: ${files.err}\n`);
    if (failureDetails.failedStepOutput) {
      process.stderr.write("\n  Output of failed step:\n");
      for (const line of failureDetails.failedStepOutput.split("\n")) {
        process.stderr.write(`    ${line}\n`);
      }
    }
  } else if (sandboxRunDir) {
    // Docker mode: discoverDockerRunDir returned nothing. Surface the
    // sandbox runs root + expected run_id so the user can still investigate
    // (instead of leaving them with only "Workflow execution failed.").
    process.stderr.write(`  Sandbox runs dir: ${sandboxRunDir}\n`);
    if (expectedRunId) {
      process.stderr.write(`    expected run_id: ${expectedRunId}\n`);
    }
    process.stderr.write(
      `  Could not locate this run's artifacts under the sandbox runs dir.\n`,
    );
  }

  return resolvedStatus;
}

function readWorkflowReturnValue(
  runDir: string | undefined,
  sandboxRunDir: string | undefined,
): string | undefined {
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
