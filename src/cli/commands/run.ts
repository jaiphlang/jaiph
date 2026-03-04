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
import { loadImportedModules, detectWorkspaceRoot } from "../shared/paths";
import { parseArgs } from "../shared/usage";
import { parseStepEvent } from "../run/events";
import {
  buildRunWrapperCommand,
  spawnRunProcess,
  setupRunSignalHandlers,
  waitForRunExit,
} from "../run/lifecycle";
import {
  buildRunTreeRows,
  type RowState,
  parseLabel,
  styleKeywordLabel,
  styleDim,
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
    const importedModules = loadImportedModules(mod);
    const rootDir = dirname(inputAbs);
    const treeRows = buildRunTreeRows(mod, "workflow default", importedModules, rootDir);
    const rowStates: RowState[] = treeRows.map((row) => (row.isRoot ? { status: "done" } : { status: "pending" }));
    const interactiveProgress = process.stdout.isTTY;
    let activeRowIndex = treeRows.length > 1 ? 1 : -1;
    const formatCompletedLine = (rowIndex: number): string => {
      const row = treeRows[rowIndex];
      const state = rowStates[rowIndex];
      return `${row.prefix}├── ${styleKeywordLabel(row.rawLabel)} ${styleDim(`(${state.elapsedSec ?? 0}s)`)}`;
    };
    const formatRunningLine = (rowIndex: number, seconds: number): string => {
      const row = treeRows[rowIndex];
      return `${row.prefix}└── ${styleKeywordLabel(row.rawLabel)} ${styleDim(`(running ${seconds}s)`)}`;
    };
    const writeActiveLine = (text: string): void => {
      process.stdout.write(`\r\u001b[2K${text}`);
    };
    const commitActiveLine = (text: string): void => {
      process.stdout.write(`\r\u001b[2K${text}\n`);
    };
    const formatNonInteractiveCompletedLine = (rowIndex: number): string => {
      const row = treeRows[rowIndex];
      const state = rowStates[rowIndex];
      const treeLead = `${row.prefix}${row.branch ?? ""}`;
      if (state.status === "failed") {
        return `${treeLead}${styleKeywordLabel(row.rawLabel)} ${styleDim(`(${state.elapsedSec ?? 0}s failed)`)}`;
      }
      return `${treeLead}${styleKeywordLabel(row.rawLabel)} ${styleDim(`(${state.elapsedSec ?? 0}s)`)}`;
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
    if (interactiveProgress) {
      process.stdout.write(`running ${basename(inputAbs)}\n`);
      process.stdout.write(`${styleKeywordLabel(treeRows[0].rawLabel)}\n`);
      if (activeRowIndex !== -1) {
        writeActiveLine(formatRunningLine(activeRowIndex, 0));
      }
    } else {
      process.stdout.write(`running ${basename(inputAbs)}\n`);
      process.stdout.write(`${styleKeywordLabel(treeRows[0].rawLabel)}\n`);
    }
    const runtimeEnv = { ...process.env, JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;
    if (runtimeEnv.JAIPH_AGENT_MODEL === undefined && effectiveConfig.agent?.defaultModel) {
      runtimeEnv.JAIPH_AGENT_MODEL = effectiveConfig.agent.defaultModel;
    }
    if (runtimeEnv.JAIPH_AGENT_COMMAND === undefined && effectiveConfig.agent?.command) {
      runtimeEnv.JAIPH_AGENT_COMMAND = effectiveConfig.agent.command;
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
    let activeStepStartedAt = startedAt;
    const findPendingRowIndex = (kind: string, name: string): number => {
      for (let i = 1; i < treeRows.length; i += 1) {
        if (rowStates[i].status !== "pending") {
          continue;
        }
        const label = parseLabel(treeRows[i].rawLabel);
        const nameMatches = label.name === name || label.name.endsWith(`.${name}`);
        if (label.kind === kind && nameMatches) {
          return i;
        }
      }
      return -1;
    };
    const findPendingRowIndexByFunc = (funcName: string): number => {
      for (let i = 1; i < treeRows.length; i += 1) {
        if (rowStates[i].status !== "pending") {
          continue;
        }
        if (treeRows[i].stepFunc === funcName) {
          return i;
        }
      }
      return -1;
    };
    const applyStepUpdate = (funcName: string, status: number, elapsedSec: number): void => {
      const kind = funcName.includes("::workflow::")
        ? "workflow"
        : funcName.includes("::rule::")
          ? "rule"
          : funcName.includes("::function::")
            ? "function"
            : funcName === "jaiph::prompt"
              ? "prompt"
              : "step";
      const name = kind === "workflow"
        ? funcName.slice(funcName.lastIndexOf("::workflow::") + "::workflow::".length)
        : kind === "rule"
          ? funcName.slice(funcName.lastIndexOf("::rule::") + "::rule::".length)
          : kind === "function"
            ? funcName.slice(funcName.lastIndexOf("::function::") + "::function::".length)
            : kind === "prompt"
              ? "prompt"
              : funcName;
      if (kind === "workflow" && name === "default") {
        return;
      }
      let changed = false;
      let changedRowIndex = findPendingRowIndexByFunc(funcName);
      if (changedRowIndex === -1) {
        changedRowIndex = findPendingRowIndex(kind, name);
      }
      if (changedRowIndex !== -1) {
        rowStates[changedRowIndex] = { status: status === 0 ? "done" : "failed", elapsedSec };
        changed = true;
      }
      if (changed) {
        if (interactiveProgress) {
          while (activeRowIndex !== -1 && rowStates[activeRowIndex].status !== "pending") {
            commitActiveLine(formatCompletedLine(activeRowIndex));
            activeRowIndex += 1;
            if (activeRowIndex >= treeRows.length) {
              activeRowIndex = -1;
              break;
            }
            writeActiveLine(formatRunningLine(activeRowIndex, 0));
          }
        } else if (changedRowIndex !== -1) {
          for (let i = 1; i < changedRowIndex; i += 1) {
            if (rowStates[i].status === "pending") {
              rowStates[i] = { status: "done", elapsedSec: 0 };
              process.stdout.write(`${formatNonInteractiveCompletedLine(i)}\n`);
            }
          }
          process.stdout.write(`${formatNonInteractiveCompletedLine(changedRowIndex)}\n`);
        }
      }
    };
    const applyStepStart = (kind: string, name: string, funcName?: string): void => {
      if (!interactiveProgress) {
        return;
      }
      if (kind === "workflow" && name === "default") {
        return;
      }
      let nextIndex = funcName !== undefined ? findPendingRowIndexByFunc(funcName) : -1;
      if (nextIndex === -1) {
        nextIndex = findPendingRowIndex(kind, name);
      }
      if (nextIndex === -1) {
        return;
      }
      if (activeRowIndex !== -1 && nextIndex > activeRowIndex) {
        for (let i = activeRowIndex; i < nextIndex; i += 1) {
          const state = rowStates[i];
          if (state.status === "pending") {
            rowStates[i] = { status: "done", elapsedSec: 0 };
          }
          commitActiveLine(formatCompletedLine(i));
        }
      }
      activeRowIndex = nextIndex;
      activeStepStartedAt = Date.now();
      writeActiveLine(formatRunningLine(activeRowIndex, 0));
    };
    const handleStderrLine = (line: string): void => {
      const event = parseStepEvent(line);
      if (event) {
        if (event.type === "STEP_START") {
          applyStepStart(event.kind, event.name, event.func);
          return;
        }
        applyStepUpdate(event.func, event.status ?? 1, Math.max(0, Math.floor((event.elapsed_ms ?? 0) / 1000)));
        return;
      }
      if (line.length > 0) {
        capturedStderr += `${line}\n`;
        if (interactiveProgress) {
          process.stdout.write("\r\u001b[2K\n");
        }
        process.stderr.write(`${line}\n`);
        if (interactiveProgress && activeRowIndex !== -1) {
          writeActiveLine(formatRunningLine(activeRowIndex, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
        }
      }
    };
    const counterTimer = setInterval(() => {
      if (interactiveProgress && activeRowIndex !== -1) {
        writeActiveLine(formatRunningLine(activeRowIndex, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
      }
    }, 1000);
    execResult.stdout?.setEncoding("utf8");
    execResult.stderr?.setEncoding("utf8");
    execResult.stdout?.on("data", (chunk: string) => {
      if (interactiveProgress) {
        process.stdout.write("\r\u001b[2K");
      }
      process.stdout.write(chunk);
      if (interactiveProgress && activeRowIndex !== -1) {
        writeActiveLine(formatRunningLine(activeRowIndex, Math.max(0, Math.floor((Date.now() - activeStepStartedAt) / 1000))));
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

    if (interactiveProgress) {
      if (activeRowIndex !== -1) {
        if (resolvedStatus === 0) {
          while (activeRowIndex !== -1 && activeRowIndex < treeRows.length) {
            const state = rowStates[activeRowIndex];
            if (state.status === "pending") {
              rowStates[activeRowIndex] = { status: "done", elapsedSec: 0 };
            }
            commitActiveLine(formatCompletedLine(activeRowIndex));
            activeRowIndex += 1;
            if (activeRowIndex >= treeRows.length) {
              activeRowIndex = -1;
            }
          }
        } else {
          writeActiveLine("");
        }
      }
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
