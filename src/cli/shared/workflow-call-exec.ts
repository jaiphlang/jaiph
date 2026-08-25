import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  spawnRunProcess,
  waitForRunExit,
  cancelRunProcess,
  armRunTimeout,
  parseRunTimeoutSeconds,
} from "../run/lifecycle";
import { parseLogEvent, parseStepEvent, type StepEvent, type LogEvent } from "../run/events";
import { redactCredentials } from "../../runtime";
import { readMetaFields, readReturnValue } from "./run-meta";
import {
  DEFAULT_OUTPUT_CAPS,
  TRUNCATION_MARKER,
  capBytes,
  type CollectedOutput,
  type OutputCaps,
  type WorkflowCallContext,
  type WorkflowCallEnvironment,
  type WorkflowCallResult,
} from "./workflow-call-types";

/** Host execution — same self-spawn path as `jaiph run --raw`. */
export async function callWorkflowHost(
  env: WorkflowCallEnvironment,
  workflowSymbol: string,
  positionalArgs: string[],
  runtimeEnv: Record<string, string | undefined>,
  runId: string,
  caps: OutputCaps,
  onStepEvent: (event: StepEvent) => void,
  ctx?: WorkflowCallContext,
  onLogEvent?: (event: LogEvent) => void,
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
  // Parent-enforced wall-clock timeout shared with `jaiph run` host mode
  // (`JAIPH_RUN_TIMEOUT`, `0`/unset disables): the same host spawn used by
  // `jaiph serve` / `jaiph mcp` calls, so an over-budget call is terminated
  // without a manual signal.
  const runTimeout = armRunTimeout(child, parseRunTimeoutSeconds(runtimeEnv));
  const collector = attachOutputCollector(child, onStepEvent, caps, onLogEvent);
  const exit = await waitForRunExit(child);
  runTimeout.cancel();
  collector.drain();

  const runDir = readMetaFields(metaFile, ["run_dir"]).run_dir;
  return composeResult(workflowSymbol, collector.data, exit, runDir, runtimeEnv, caps);
}

/**
 * Attach line-oriented listeners to a run child's stderr/stdout. Parses
 * `__JAIPH_EVENT__` log/step lines from stderr (child stdout is captured but
 * never forwarded). `onStepEvent` (when given) fires once per parsed
 * `STEP_START`/`STEP_END` event with the full event so the caller can stream
 * progress and dispatch hooks. `onLogEvent` (when given) fires once per parsed
 * LOG/LOGWARN/LOGERR event so the operator log can mirror it — independent of
 * the byte-capped `data.logs` accumulation below. `drain()` flushes any trailing
 * partial stderr line.
 */
export function attachOutputCollector(
  child: ChildProcess,
  onStepEvent: ((event: StepEvent) => void) | undefined,
  caps: OutputCaps,
  onLogEvent?: (event: LogEvent) => void,
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
      onLogEvent?.(logEvent);
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
      onStepEvent?.(stepEvent);
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
  env: NodeJS.ProcessEnv,
  caps: OutputCaps = DEFAULT_OUTPUT_CAPS,
): WorkflowCallResult {
  const failed = exit.status !== 0 || exit.signal !== null;

  if (!failed) {
    const returnValue = readReturnValue(runDir);
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

function trimTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
