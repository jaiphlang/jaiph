import { parseStepEvent, parseLogEvent } from "./events";
import { colorize, formatStartLine, formatCompletedLine } from "./display";
import { formatRunningBottomLine } from "./progress";
import { runHooksForEvent, type MergedHookConfig } from "./hooks";

export type StderrHandlerState = {
  stepIndentById: Map<string, string>;
  runtimeStack: string[];
  legacyStack: string[];
  legacyCounter: number;
  rootStepId: string | null;
  workflowRunId: string;
  capturedStderr: string;
};

export type StderrHandlerContext = {
  isTTY: boolean;
  colorEnabled: boolean;
  startedAt: number;
  runningInterval: ReturnType<typeof setInterval> | undefined;
  hooksConfig: MergedHookConfig;
  inputAbs: string;
  workspaceRoot: string;
};

export function createStderrHandlerState(): StderrHandlerState {
  return {
    stepIndentById: new Map(),
    runtimeStack: [],
    legacyStack: [],
    legacyCounter: 0,
    rootStepId: null,
    workflowRunId: "",
    capturedStderr: "",
  };
}

function removeLastMatching(stack: string[], id: string): void {
  const idx = stack.lastIndexOf(id);
  if (idx === -1) return;
  stack.splice(idx, 1);
}

function resolveEventId(
  state: StderrHandlerState,
  eventType: "STEP_START" | "STEP_END",
  eventId: string,
  funcName: string,
): string {
  if (eventId.length > 0) return eventId;
  if (eventType === "STEP_START") {
    state.legacyCounter += 1;
    const id = `legacy:${state.legacyCounter}:${funcName}`;
    state.legacyStack.push(id);
    return id;
  }
  const fromStack = state.legacyStack.pop();
  if (fromStack) return fromStack;
  state.legacyCounter += 1;
  return `legacy:${state.legacyCounter}:${funcName}`;
}

/** Clear the TTY running line, write content, then redraw the running line. */
function writeTTYLine(line: string, ctx: StderrHandlerContext): void {
  if (ctx.isTTY && ctx.runningInterval !== undefined) {
    process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
  }
  process.stdout.write(`${line}${ctx.isTTY ? "\n\n" : "\n"}`);
  if (ctx.isTTY && ctx.runningInterval !== undefined) {
    const elapsedSec = (Date.now() - ctx.startedAt) / 1000;
    process.stdout.write(formatRunningBottomLine("default", elapsedSec));
  }
}

export function handleStderrLine(
  line: string,
  state: StderrHandlerState,
  ctx: StderrHandlerContext,
): void {
  const logEvent = parseLogEvent(line);
  if (logEvent) {
    const depth = Math.max(1, logEvent.depth);
    const indent = "  · ".repeat(depth);
    const prefix = indent.slice(0, -2);
    const dimPrefix = colorize(prefix, "dim", ctx.colorEnabled);
    const logLabel = logEvent.type === "LOGERR"
      ? `${dimPrefix}${colorize(`! ${logEvent.message}`, "red", ctx.colorEnabled)}`
      : `${dimPrefix}${colorize("ℹ", "dim", ctx.colorEnabled)} ${logEvent.message}`;
    writeTTYLine(logLabel, ctx);
    return;
  }

  const event = parseStepEvent(line);
  if (event) {
    if (event.run_id && !state.workflowRunId) state.workflowRunId = event.run_id;
    const eventId = resolveEventId(state, event.type, event.id, event.func);

    if (event.type === "STEP_START") {
      runHooksForEvent(ctx.hooksConfig, "step_start", {
        event: "step_start",
        workflow_id: event.run_id,
        step_id: eventId,
        step_kind: event.kind,
        step_name: event.name,
        timestamp: event.ts || new Date().toISOString(),
        run_path: ctx.inputAbs,
        workspace: ctx.workspaceRoot,
      });
      if (event.kind === "workflow" && event.name === "default" && state.runtimeStack.length === 0) {
        state.rootStepId = eventId;
        state.runtimeStack.push(eventId);
        return;
      }
      const depth = Math.max(1, event.depth ?? state.runtimeStack.length);
      const indent = "  · ".repeat(depth);
      const label = formatStartLine(indent, event.kind, event.name, ctx.colorEnabled, event.params);
      state.stepIndentById.set(eventId, indent);
      writeTTYLine(label, ctx);
      state.runtimeStack.push(eventId);
      return;
    }

    // STEP_END
    const elapsedSec = Math.max(0, Math.floor((event.elapsed_ms ?? 0) / 1000));
    if (!(event.kind === "workflow" && event.name === "default" && eventId === state.rootStepId)) {
      const indent = state.stepIndentById.get(eventId) ?? "  · ";
      const completedLine = formatCompletedLine(indent, event.status ?? 1, elapsedSec, ctx.colorEnabled);
      writeTTYLine(completedLine, ctx);
      state.stepIndentById.delete(eventId);
    }
    runHooksForEvent(ctx.hooksConfig, "step_end", {
      event: "step_end",
      workflow_id: event.run_id,
      step_id: eventId,
      step_kind: event.kind,
      step_name: event.name,
      status: event.status ?? 1,
      elapsed_ms: event.elapsed_ms ?? 0,
      timestamp: event.ts || new Date().toISOString(),
      run_path: ctx.inputAbs,
      workspace: ctx.workspaceRoot,
      out_file: event.out_file || undefined,
      err_file: event.err_file || undefined,
    });
    removeLastMatching(state.runtimeStack, eventId);
    return;
  }

  if (line.length > 0) {
    if (ctx.isTTY && ctx.runningInterval !== undefined) {
      process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
    }
    state.capturedStderr += `${line}\n`;
    if (!ctx.isTTY) {
      process.stderr.write(`${line}\n`);
    }
    if (ctx.isTTY && ctx.runningInterval !== undefined) {
      const elapsedSec = (Date.now() - ctx.startedAt) / 1000;
      process.stdout.write(formatRunningBottomLine("default", elapsedSec));
    }
  }
}
