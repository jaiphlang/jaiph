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
import {
  colorPalette,
  summarizeError,
  hasFatalRuntimeStderr,
  latestRunFiles,
  readFailedStepOutput,
} from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { parseArgs } from "../shared/usage";
import { parseStepEvent } from "../run/events";
import {
  buildRunWrapperCommand,
  spawnRunProcess,
  setupRunSignalHandlers,
  waitForRunExit,
} from "../run/lifecycle";
import {
  beginRuntimeNode,
  completeRuntimeNode,
  createRuntimeGraphStore,
  runtimeCompletedLine,
  renderRuntimeTreeRows,
  runtimeRunningLine,
  styleKeywordLabel,
  formatElapsedDuration,
} from "../run/progress";

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
    const graphStore = createRuntimeGraphStore(rootLabel);
    const interactiveProgress = process.stdout.isTTY;
    let activeNodeId: string | null = null;
    const writeActiveLine = (text: string): void => {
      process.stdout.write(`\r\u001b[2K${text}`);
    };
    const commitActiveLine = (text: string): void => {
      process.stdout.write(`\r\u001b[2K${text}\n`);
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
    const runBanner = `\nrunning ${basename(inputAbs)}\n\n`;
    if (interactiveProgress) {
      process.stdout.write(runBanner);
      process.stdout.write(`${styleKeywordLabel(rootLabel)}\n`);
    } else {
      process.stdout.write(runBanner);
      process.stdout.write(`${styleKeywordLabel(rootLabel)}\n`);
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
    delete runtimeEnv.BASH_ENV;
    delete runtimeEnv.JAIPH_RUN_DIR;
    delete runtimeEnv.JAIPH_PRECEDING_FILES;
    delete runtimeEnv.JAIPH_RUN_SUMMARY_FILE;
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);
    const execResult = spawnRunProcess(command, [metaFile, builtPath, workflowSymbol, ...runArgs], {
      cwd: workspaceRoot,
      env: runtimeEnv,
    });
    const signalHandlers = setupRunSignalHandlers(execResult, { forceKillAfterMs: 1500 });
    let capturedStderr = "";
    let stderrBuffer = "";
    let bufferedStdout = "";
    let activeStepStartedAt = startedAt;
    const runtimeStack: string[] = [];
    const legacyStack: string[] = [];
    let legacyCounter = 0;
    const removeLastMatching = (stack: string[], id: string): void => {
      const idx = stack.lastIndexOf(id);
      if (idx === -1) return;
      stack.splice(idx, 1);
    };
    const resolveCurrentActiveNodeId = (): string | null => {
      for (let i = runtimeStack.length - 1; i >= 0; i -= 1) {
        const id = runtimeStack[i];
        if (graphStore.nodesById.has(id)) {
          return id;
        }
      }
      return null;
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
      const event = parseStepEvent(line);
      if (event) {
        const eventId = resolveEventId(event.type, event.id, event.func);
        if (event.type === "STEP_START") {
          const rawLabel = `${event.kind} ${event.name}`;
          const parentCandidate = event.parent_id ?? (runtimeStack.length > 0 ? runtimeStack[runtimeStack.length - 1] : null);
          if (event.kind === "workflow" && event.name === "default") {
            graphStore.rootStepId = eventId;
            runtimeStack.push(eventId);
            activeNodeId = resolveCurrentActiveNodeId();
            return;
          }
          const parentId = parentCandidate === graphStore.rootStepId ? null : parentCandidate;
          beginRuntimeNode(graphStore, eventId, parentId, rawLabel, Date.now());
          runtimeStack.push(eventId);
          if (interactiveProgress) {
            activeNodeId = eventId;
            activeStepStartedAt = Date.now();
            writeActiveLine(runtimeRunningLine(graphStore, activeNodeId, 0));
          }
          return;
        }
        const elapsedSec = Math.max(0, Math.floor((event.elapsed_ms ?? 0) / 1000));
        if (!(event.kind === "workflow" && event.name === "default")) {
          const completed = completeRuntimeNode(graphStore, eventId, event.status ?? 1, elapsedSec);
          if (completed) {
            if (interactiveProgress) {
              const rendered = runtimeCompletedLine(graphStore, eventId);
              commitActiveLine(rendered);
            }
          }
        }
        removeLastMatching(runtimeStack, eventId);
        activeNodeId = resolveCurrentActiveNodeId();
        if (interactiveProgress && activeNodeId !== null) {
          activeStepStartedAt = Date.now();
          writeActiveLine(runtimeRunningLine(graphStore, activeNodeId, 0));
        }
        return;
      }
      if (line.length > 0) {
        capturedStderr += `${line}\n`;
        if (interactiveProgress) {
          process.stdout.write("\r\u001b[2K\n");
        }
        process.stderr.write(`${line}\n`);
        if (interactiveProgress && activeNodeId !== null) {
          writeActiveLine(runtimeRunningLine(graphStore, activeNodeId, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
        }
      }
    };
    const counterTimer = setInterval(() => {
      if (interactiveProgress && activeNodeId !== null) {
        writeActiveLine(runtimeRunningLine(graphStore, activeNodeId, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
      }
    }, 1000);
    execResult.stdout?.setEncoding("utf8");
    execResult.stderr?.setEncoding("utf8");
    execResult.stdout?.on("data", (chunk: string) => {
      if (!interactiveProgress) {
        bufferedStdout += chunk;
        return;
      }
      if (interactiveProgress) {
        process.stdout.write("\r\u001b[2K");
      }
      process.stdout.write(chunk);
      if (interactiveProgress && activeNodeId !== null) {
        writeActiveLine(runtimeRunningLine(graphStore, activeNodeId, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
      }
    });
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
    clearInterval(counterTimer);
    if (stderrBuffer.length > 0) {
      const remaining = stderrBuffer.replace(/\r$/, "").split(/\r?\n/);
      for (const line of remaining) {
        if (line.length > 0) {
          handleStderrLine(line);
        }
      }
      stderrBuffer = "";
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
    if (!interactiveProgress) {
      for (const row of renderRuntimeTreeRows(graphStore)) {
        process.stdout.write(`${row}\n`);
      }
      process.stdout.write(bufferedStdout);
    }

    if (interactiveProgress && activeNodeId !== null) {
      writeActiveLine("");
    }

    const palette = colorPalette();
    if (resolvedStatus === 0) {
      process.stdout.write(
        `${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedLabel})${palette.reset}\n`,
      );
      return 0;
    }

    const summary = summarizeError(capturedStderr, "Workflow execution failed.");
    process.stderr.write(
      `${palette.red}\u2717 FAIL${palette.reset} workflow default ${palette.dim}(${elapsedLabel})${palette.reset}\n`,
    );
    process.stderr.write(`  ${summary}\n`);
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
      const failedStepOutput = summaryFile ? readFailedStepOutput(summaryFile) : null;
      if (failedStepOutput) {
        process.stderr.write("\n  Output of failed step:\n");
        for (const line of failedStepOutput.split("\n")) {
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
