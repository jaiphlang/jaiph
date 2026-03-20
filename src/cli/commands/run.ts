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
import { formatNamedParamsForDisplay, isInternalParamValue } from "./format-params.js";
import {
  colorPalette,
  resolveFailureDetails,
  hasFatalRuntimeStderr,
  latestRunFiles,
} from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { parseArgs } from "../shared/usage";
import { parseStepEvent, parseLogEvent } from "../run/events";
import {
  buildRunWrapperCommand,
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
import { loadMergedHooks, runHooksForEvent } from "../run/hooks";

export async function runWorkflow(rest: string[]): Promise<number> {
  const { target, positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);
  if (!input) {
    process.stderr.write("jaiph run requires a .jh or .jph file path\n");
    return 1;
  }
  const inputAbs = resolve(input);
  const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
  const hooksConfig = loadMergedHooks(workspaceRoot);
  const inputStat = statSync(inputAbs);
  const ext = extname(inputAbs);
  if (!inputStat.isFile() || (ext !== ".jph" && ext !== ".jh")) {
    process.stderr.write("jaiph run expects a single .jh or .jph file\n");
    return 1;
  }
  if (ext === ".jph" && process.stderr.isTTY) {
    process.stderr.write(
      "jaiph: .jph extension is deprecated; use .jh for new files. Migration: mv *.jph *.jh\n",
    );
  }

  const mod = parsejaiph(readFileSync(inputAbs, "utf8"), inputAbs);
  const effectiveConfig = metadataToConfig(mod.metadata);

  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const rootLabel = "workflow default";
    const stepIndentById = new Map<string, string>();
    const colorEnabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
    const colorize = (
      text: string,
      code: "dim" | "bold" | "green" | "red",
    ): string => {
      if (!colorEnabled) return text;
      const prefix = code === "dim"
        ? "\u001b[2m"
        : code === "bold"
          ? "\u001b[1m"
          : code === "green"
            ? "\u001b[32m"
            : "\u001b[31m";
      return `${prefix}${text}\u001b[0m`;
    };
const PROMPT_PREVIEW_MAX = 24;
const PROMPT_ARGS_DISPLAY_MAX = 96;
    const formatStartLine = (indent: string, kind: string, name: string, params?: Array<[string, string]>): string => {
      const prefix = indent.slice(0, -2);
      const marker = colorize("▸", "dim");
      const kindLabel = colorize(kind, "bold");
      const dimPrefix = colorize(prefix, "dim");
      let namePart: string;
      let paramSuffix = "";
      if (kind === "prompt" && params != null && params.length > 0) {
        const previewValue =
          params.map(([, v]) => v).find((v) => !isInternalParamValue(v)) ?? "";
        const oneLine = previewValue.replace(/\s+/g, " ").trim();
        const previewDisplay =
          oneLine.length > PROMPT_PREVIEW_MAX
            ? `${oneLine.slice(0, PROMPT_PREVIEW_MAX)}...`
            : oneLine;
        const escaped = previewDisplay.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        namePart = previewDisplay.length > 0 ? `${kindLabel} "${escaped}"` : `${kindLabel} ${name}`;
        const restParams = params.filter(([, v]) => !isInternalParamValue(v));
        const skipFirst = restParams.length > 0 && restParams[0][1] === previewValue ? 1 : 0;
        const restForSuffix = restParams.slice(skipFirst);
        paramSuffix =
          restForSuffix.length > 0
            ? colorize(
                formatNamedParamsForDisplay(restForSuffix, { capTotalLength: PROMPT_ARGS_DISPLAY_MAX }),
                "dim",
              )
            : "";
      } else {
        namePart = kind === name ? kindLabel : `${kindLabel} ${name}`;
        const showParams =
          params != null &&
          params.length > 0 &&
          (kind === "workflow" || kind === "prompt" || kind === "function" || kind === "rule");
        paramSuffix = showParams
          ? colorize(formatNamedParamsForDisplay(params), "dim")
          : "";
      }
      return `${dimPrefix}${marker} ${namePart}${paramSuffix}`;
    };
    const formatCompletedLine = (indent: string, status: number, elapsedSec: number): string => {
      const prefix = indent.slice(0, -2);
      const dimPrefix = colorize(prefix, "dim");
      if (status === 0) {
        const ok = colorize("✓", "green");
        const elapsed = colorize(`${elapsedSec}s`, "dim");
        return `${dimPrefix}${ok} ${elapsed}`;
      }
      const fail = colorize(`✗ ${elapsedSec}s`, "red");
      return `${dimPrefix}${fail}`;
    };

    const results = build(inputAbs, outDir);
    if (results.length !== 1) {
      process.stderr.write(`jaiph run expected one built output, got ${results.length}\n`);
      return 1;
    }
    const builtPath = results[0].outputPath;
    const workflowSymbol = workflowSymbolForFile(inputAbs, dirname(inputAbs));
    const command = buildRunWrapperCommand();
    const startedAt = Date.now();
    const runBanner = `\nJaiph: Running ${basename(inputAbs)}\n\n`;
    process.stdout.write(runBanner);
    const rootParamsSuffix =
      runArgs.length > 0
        ? colorize(formatNamedParamsForDisplay(runArgs.map((a, i) => [String(i + 1), a] as [string, string])), "dim")
        : "";
    process.stdout.write(`${styleKeywordLabel(rootLabel)}${rootParamsSuffix}\n`);
    const isTTY = process.stdout.isTTY;
    let runningInterval: ReturnType<typeof setInterval> | undefined;
    if (isTTY) {
      process.stdout.write("\n" + formatRunningBottomLine("default", 0));
      runningInterval = setInterval(() => {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        process.stdout.write("\r" + formatRunningBottomLine("default", elapsedSec) + "\u001b[K");
      }, 1000);
    }
    const runtimeEnv = { ...process.env, JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;
    if (process.env.JAIPH_AGENT_MODEL !== undefined) {
      runtimeEnv.JAIPH_AGENT_MODEL_LOCKED = "1";
    }
    if (process.env.JAIPH_AGENT_COMMAND !== undefined) {
      runtimeEnv.JAIPH_AGENT_COMMAND_LOCKED = "1";
    }
    if (process.env.JAIPH_AGENT_BACKEND !== undefined) {
      runtimeEnv.JAIPH_AGENT_BACKEND_LOCKED = "1";
    }
    if (process.env.JAIPH_AGENT_TRUSTED_WORKSPACE !== undefined) {
      runtimeEnv.JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED = "1";
    }
    if (process.env.JAIPH_AGENT_CURSOR_FLAGS !== undefined) {
      runtimeEnv.JAIPH_AGENT_CURSOR_FLAGS_LOCKED = "1";
    }
    if (process.env.JAIPH_AGENT_CLAUDE_FLAGS !== undefined) {
      runtimeEnv.JAIPH_AGENT_CLAUDE_FLAGS_LOCKED = "1";
    }
    if (process.env.JAIPH_RUNS_DIR !== undefined) {
      runtimeEnv.JAIPH_RUNS_DIR_LOCKED = "1";
    }
    if (process.env.JAIPH_DEBUG !== undefined) {
      runtimeEnv.JAIPH_DEBUG_LOCKED = "1";
    }
    if (runtimeEnv.JAIPH_AGENT_MODEL === undefined && effectiveConfig.agent?.defaultModel) {
      runtimeEnv.JAIPH_AGENT_MODEL = effectiveConfig.agent.defaultModel;
    }
    if (runtimeEnv.JAIPH_AGENT_COMMAND === undefined && effectiveConfig.agent?.command) {
      runtimeEnv.JAIPH_AGENT_COMMAND = effectiveConfig.agent.command;
    }
    if (runtimeEnv.JAIPH_AGENT_BACKEND === undefined && effectiveConfig.agent?.backend) {
      runtimeEnv.JAIPH_AGENT_BACKEND = effectiveConfig.agent.backend;
    }
    if (runtimeEnv.JAIPH_AGENT_TRUSTED_WORKSPACE === undefined) {
      if (effectiveConfig.agent?.trustedWorkspace) {
        runtimeEnv.JAIPH_AGENT_TRUSTED_WORKSPACE = resolve(workspaceRoot, effectiveConfig.agent.trustedWorkspace);
      } else {
        runtimeEnv.JAIPH_AGENT_TRUSTED_WORKSPACE = workspaceRoot;
      }
    }
    if (runtimeEnv.JAIPH_AGENT_CURSOR_FLAGS === undefined && effectiveConfig.agent?.cursorFlags) {
      runtimeEnv.JAIPH_AGENT_CURSOR_FLAGS = effectiveConfig.agent.cursorFlags;
    }
    if (runtimeEnv.JAIPH_AGENT_CLAUDE_FLAGS === undefined && effectiveConfig.agent?.claudeFlags) {
      runtimeEnv.JAIPH_AGENT_CLAUDE_FLAGS = effectiveConfig.agent.claudeFlags;
    }
    if (runtimeEnv.JAIPH_RUNS_DIR === undefined && effectiveConfig.run?.logsDir) {
      runtimeEnv.JAIPH_RUNS_DIR = effectiveConfig.run.logsDir;
    }
    if (runtimeEnv.JAIPH_DEBUG === undefined && effectiveConfig.run?.debug === true) {
      runtimeEnv.JAIPH_DEBUG = "true";
    }
    if (runtimeEnv.JAIPH_STDLIB === undefined) {
      runtimeEnv.JAIPH_STDLIB = join(__dirname, "..", "..", "jaiph_stdlib.sh");
    }
    runtimeEnv.JAIPH_SOURCE_FILE = basename(inputAbs);
    delete runtimeEnv.BASH_ENV;
    delete runtimeEnv.JAIPH_RUN_DIR;
    delete runtimeEnv.JAIPH_PRECEDING_FILES;
    delete runtimeEnv.JAIPH_RUN_SUMMARY_FILE;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);
    runHooksForEvent(hooksConfig, "workflow_start", {
      event: "workflow_start",
      workflow_id: "",
      timestamp: new Date().toISOString(),
      run_path: inputAbs,
      workspace: workspaceRoot,
    });

    // Resolve Docker config (env > in-file > defaults)
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
        wrapperCommand: command,
        metaFile,
        workflowSymbol,
        runArgs,
        env: runtimeEnv,
        isTTY: !!isTTY,
      });
      execResult = dockerResult.child;
    } else {
      execResult = spawnRunProcess(command, [metaFile, builtPath, workflowSymbol, ...runArgs], {
        cwd: workspaceRoot,
        env: runtimeEnv,
      });
    }

    const signalHandlers = setupRunSignalHandlers(execResult, { forceKillAfterMs: 1500 });
    let capturedStderr = "";
    let stderrBuffer = "";
    let workflowRunId = "";
    const runtimeStack: string[] = [];
    const legacyStack: string[] = [];
    let legacyCounter = 0;
    let rootStepId: string | null = null;
    const removeLastMatching = (stack: string[], id: string): void => {
      const idx = stack.lastIndexOf(id);
      if (idx === -1) return;
      stack.splice(idx, 1);
    };
    const resolveEventId = (eventType: "STEP_START" | "STEP_END", eventId: string, funcName: string): string => {
      if (eventId.length > 0) {
        return eventId;
      }
      if (eventType === "STEP_START") {
        legacyCounter += 1;
        const id = `legacy:${legacyCounter}:${funcName}`;
        legacyStack.push(id);
        return id;
      }
      const fromStack = legacyStack.pop();
      if (fromStack) {
        return fromStack;
      }
      legacyCounter += 1;
      return `legacy:${legacyCounter}:${funcName}`;
    };
    const handleStderrLine = (line: string): void => {
      const logEvent = parseLogEvent(line);
      if (logEvent) {
        const depth = Math.max(1, logEvent.depth);
        const indent = "  · ".repeat(depth);
        const prefix = indent.slice(0, -2);
        const dimPrefix = colorize(prefix, "dim");
        let logLabel: string;
        if (logEvent.type === "LOGERR") {
          logLabel = `${dimPrefix}${colorize(`! ${logEvent.message}`, "red")}`;
        } else {
          logLabel = `${dimPrefix}${colorize("ℹ", "dim")} ${logEvent.message}`;
        }
        if (isTTY && runningInterval !== undefined) {
          process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
        }
        process.stdout.write(`${logLabel}${isTTY ? "\n\n" : "\n"}`);
        if (isTTY && runningInterval !== undefined) {
          const elapsedSec = (Date.now() - startedAt) / 1000;
          process.stdout.write(formatRunningBottomLine("default", elapsedSec));
        }
        return;
      }
      const event = parseStepEvent(line);
      if (event) {
        if (event.run_id && !workflowRunId) workflowRunId = event.run_id;
        const eventId = resolveEventId(event.type, event.id, event.func);
        if (event.type === "STEP_START") {
          runHooksForEvent(hooksConfig, "step_start", {
            event: "step_start",
            workflow_id: event.run_id,
            step_id: eventId,
            step_kind: event.kind,
            step_name: event.name,
            timestamp: event.ts || new Date().toISOString(),
            run_path: inputAbs,
            workspace: workspaceRoot,
          });
          if (event.kind === "workflow" && event.name === "default" && runtimeStack.length === 0) {
            rootStepId = eventId;
            runtimeStack.push(eventId);
            return;
          }
          const depth = Math.max(1, event.depth ?? runtimeStack.length);
          const indent = "  · ".repeat(depth);
          const label = formatStartLine(indent, event.kind, event.name, event.params);
          stepIndentById.set(eventId, indent);
          if (isTTY && runningInterval !== undefined) {
            process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
          }
          process.stdout.write(`${label}${isTTY ? "\n\n" : "\n"}`);
          if (isTTY && runningInterval !== undefined) {
            const elapsedSec = (Date.now() - startedAt) / 1000;
            process.stdout.write(formatRunningBottomLine("default", elapsedSec));
          }
          runtimeStack.push(eventId);
          return;
        }
        const elapsedSec = Math.max(0, Math.floor((event.elapsed_ms ?? 0) / 1000));
        if (!(event.kind === "workflow" && event.name === "default" && eventId === rootStepId)) {
          const indent = (stepIndentById.get(eventId) ?? "  · ");
          const completedLine = formatCompletedLine(indent, event.status ?? 1, elapsedSec);
          if (isTTY && runningInterval !== undefined) {
            process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
          }
          process.stdout.write(`${completedLine}${isTTY ? "\n\n" : "\n"}`);
          // No embedded step output in tree; output appears only when user calls log. Full transcript stays in .out files.
          if (isTTY && runningInterval !== undefined) {
            const runningElapsedSec = (Date.now() - startedAt) / 1000;
            process.stdout.write(formatRunningBottomLine("default", runningElapsedSec));
          }
          stepIndentById.delete(eventId);
        }
        runHooksForEvent(hooksConfig, "step_end", {
          event: "step_end",
          workflow_id: event.run_id,
          step_id: eventId,
          step_kind: event.kind,
          step_name: event.name,
          status: event.status ?? 1,
          elapsed_ms: event.elapsed_ms ?? 0,
          timestamp: event.ts || new Date().toISOString(),
          run_path: inputAbs,
          workspace: workspaceRoot,
          out_file: event.out_file || undefined,
          err_file: event.err_file || undefined,
        });
        removeLastMatching(runtimeStack, eventId);
        return;
      }
      if (line.length > 0) {
        if (isTTY && runningInterval !== undefined) {
          process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
        }
        capturedStderr += `${line}\n`;
        if (!isTTY) {
          process.stderr.write(`${line}\n`);
        }
        if (isTTY && runningInterval !== undefined) {
          const elapsedSec = (Date.now() - startedAt) / 1000;
          process.stdout.write(formatRunningBottomLine("default", elapsedSec));
        }
      }
    };
    execResult.stdout?.setEncoding("utf8");
    execResult.stderr?.setEncoding("utf8");
    let stdoutBuffer = "";
    if (dockerConfig.enabled) {
      // Docker with -t merges stderr into stdout, so event lines arrive on
      // stdout.  Buffer line-by-line and route event lines through the same
      // handler that normally processes stderr.
      //
      // NOTE (out-of-scope): Docker TTY mode merges stdout and stderr into a
      // single stream.  The line-based demux below separates event lines from
      // user output, but ordering and timing may still differ from non-Docker
      // mode because of this merged stream.  This is a known limitation and
      // should be addressed in a follow-up if needed.
      execResult.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (parseLogEvent(line) || parseStepEvent(line)) {
            handleStderrLine(line);
          } else {
            process.stdout.write(`${line}\n`);
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
    } else {
      execResult.stdout?.on("data", (chunk: string) => {
        process.stdout.write(chunk);
      });
    }
    execResult.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        handleStderrLine(line);
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });
    const childExit = await waitForRunExit(execResult, () => signalHandlers.remove());
    if (stdoutBuffer.length > 0) {
      const remaining = stdoutBuffer.replace(/\r$/, "").split(/\r?\n/);
      for (const line of remaining) {
        if (line.length > 0) {
          if (dockerConfig.enabled && (parseLogEvent(line) || parseStepEvent(line))) {
            handleStderrLine(line);
          } else {
            process.stdout.write(`${line}\n`);
          }
        }
      }
      stdoutBuffer = "";
    }
    if (stderrBuffer.length > 0) {
      const remaining = stderrBuffer.replace(/\r$/, "").split(/\r?\n/);
      for (const line of remaining) {
        if (line.length > 0) {
          handleStderrLine(line);
        }
      }
      stderrBuffer = "";
    }
    // Clean up Docker resources
    if (dockerResult) {
      const timedOut = dockerResult.timeoutTimer === undefined && dockerConfig.timeout > 0
        ? false
        : (Date.now() - startedAt) >= dockerConfig.timeout * 1000;
      cleanupDocker(dockerResult);
      if (timedOut && childExit.status !== 0) {
        capturedStderr += "E_TIMEOUT container execution exceeded timeout\n";
      }
    }

    if (childExit.signal && capturedStderr.trim().length === 0) {
      capturedStderr = `Process terminated by signal ${childExit.signal}`;
    }
    const elapsedMs = Date.now() - startedAt;
    const elapsedLabel = formatElapsedDuration(elapsedMs);
    let runDir: string | undefined;
    let summaryFile: string | undefined;
    if (existsSync(metaFile)) {
      const metaLines = readFileSync(metaFile, "utf8").split(/\r?\n/);
      for (const line of metaLines) {
        if (line.startsWith("run_dir=")) {
          const value = line.slice("run_dir=".length).trim();
          if (value) {
            runDir = value;
          }
        }
        if (line.startsWith("summary_file=")) {
          const value = line.slice("summary_file=".length).trim();
          if (value) {
            summaryFile = value;
          }
        }
      }
    }
    const runtimeDebugEnabled = runtimeEnv.JAIPH_DEBUG === "true";
    const runtimeErrorPrinted = hasFatalRuntimeStderr(capturedStderr, runtimeDebugEnabled);
    const resolvedStatus = childExit.status !== 0 || runtimeErrorPrinted ? 1 : 0;

    if (runningInterval !== undefined) {
      clearInterval(runningInterval);
      runningInterval = undefined;
      process.stdout.write("\r\u001b[K");
    }

    runHooksForEvent(hooksConfig, "workflow_end", {
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
      const files = latestRunFiles(runDir);
      if (files.out) {
        process.stderr.write(`    out: ${files.out}\n`);
      }
      if (files.err) {
        process.stderr.write(`    err: ${files.err}\n`);
      }
      if (failureDetails.failedStepOutput) {
        process.stderr.write("\n  Output of failed step:\n");
        for (const line of failureDetails.failedStepOutput.split("\n")) {
          process.stderr.write(`    ${line}\n`);
        }
      }
    }

    return resolvedStatus;
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}
