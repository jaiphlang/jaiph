import { parseStepEvent, parseLogEvent } from "./events";
import { colorize, formatStartLine, formatCompletedLine } from "./display";
import { formatRunningBottomLine } from "./progress";
import type { RunEmitter } from "./emitter";

// ── Parser state (internal to stderr line parsing) ──

type StderrParserState = {
  runtimeStack: string[];
  legacyStack: string[];
  legacyCounter: number;
  rootStepId: string | null;
};

function removeLastMatching(stack: string[], id: string): void {
  const idx = stack.lastIndexOf(id);
  if (idx !== -1) stack.splice(idx, 1);
}

function resolveEventId(
  state: StderrParserState,
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

function handleLine(line: string, state: StderrParserState, emitter: RunEmitter): void {
  const logEvent = parseLogEvent(line);
  if (logEvent) {
    emitter.emit("log", logEvent);
    return;
  }

  const event = parseStepEvent(line);
  if (event) {
    const eventId = resolveEventId(state, event.type, event.id, event.func);

    if (event.type === "STEP_START") {
      const isRoot = event.kind === "workflow" && event.name === "default" && state.runtimeStack.length === 0;
      if (isRoot) state.rootStepId = eventId;
      const depth = Math.max(1, event.depth ?? state.runtimeStack.length);
      state.runtimeStack.push(eventId);
      emitter.emit("step_start", { event, eventId, depth, isRoot });
      return;
    }

    // STEP_END
    const isRoot = event.kind === "workflow" && event.name === "default" && eventId === state.rootStepId;
    emitter.emit("step_end", { event, eventId, isRoot });
    removeLastMatching(state.runtimeStack, eventId);
    return;
  }

  if (line.length > 0) {
    emitter.emit("stderr_line", { line });
  }
}

/** Create a line handler that parses stderr lines and emits events through the emitter. */
export function createStderrParser(emitter: RunEmitter): (line: string) => void {
  const state: StderrParserState = {
    runtimeStack: [], legacyStack: [], legacyCounter: 0, rootStepId: null,
  };
  return (line: string) => handleLine(line, state, emitter);
}

// ── Run state (shared output read by runWorkflow after exit) ──

export type RunState = {
  workflowRunId: string;
  capturedStderr: string;
};

export function createRunState(): RunState {
  return { workflowRunId: "", capturedStderr: "" };
}

// ── Subscriber: state tracking ──

export function registerStateSubscriber(emitter: RunEmitter, state: RunState): void {
  emitter.on("step_start", (data) => {
    if (data.event.run_id && !state.workflowRunId) state.workflowRunId = data.event.run_id;
  });
  emitter.on("step_end", (data) => {
    if (data.event.run_id && !state.workflowRunId) state.workflowRunId = data.event.run_id;
  });
  emitter.on("stderr_line", (data) => {
    state.capturedStderr += `${data.line}\n`;
  });
}

// ── Subscriber: TTY rendering ──

export type TTYContext = {
  isTTY: boolean;
  colorEnabled: boolean;
  startedAt: number;
  runningInterval: ReturnType<typeof setInterval> | undefined;
};

function writeTTYLine(line: string, ctx: TTYContext): void {
  if (ctx.isTTY && ctx.runningInterval !== undefined) {
    process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
  }
  process.stdout.write(`${line}${ctx.isTTY ? "\n\n" : "\n"}`);
  if (ctx.isTTY && ctx.runningInterval !== undefined) {
    const elapsedSec = (Date.now() - ctx.startedAt) / 1000;
    process.stdout.write(formatRunningBottomLine("default", elapsedSec));
  }
}

export function registerTTYSubscriber(emitter: RunEmitter, ctx: TTYContext): void {
  const stepIndentById = new Map<string, string>();

  emitter.on("log", (logEvent) => {
    const depth = Math.max(1, logEvent.depth);
    const indent = "  · ".repeat(depth);
    const prefix = indent.slice(0, -2);
    const dimPrefix = colorize(prefix, "dim", ctx.colorEnabled);
    const logLabel = logEvent.type === "LOGERR"
      ? `${dimPrefix}${colorize(`! ${logEvent.message}`, "red", ctx.colorEnabled)}`
      : `${dimPrefix}${colorize("ℹ", "dim", ctx.colorEnabled)} ${logEvent.message}`;
    writeTTYLine(logLabel, ctx);
  });

  emitter.on("step_start", (data) => {
    if (data.isRoot) return;
    const indent = "  · ".repeat(data.depth);
    const label = formatStartLine(indent, data.event.kind, data.event.name, ctx.colorEnabled, data.event.params);
    stepIndentById.set(data.eventId, indent);
    writeTTYLine(label, ctx);
  });

  emitter.on("step_end", (data) => {
    if (data.isRoot) return;
    const elapsedSec = Math.max(0, Math.floor((data.event.elapsed_ms ?? 0) / 1000));
    const indent = stepIndentById.get(data.eventId) ?? "  · ";
    const completedLine = formatCompletedLine(indent, data.event.status ?? 1, elapsedSec, ctx.colorEnabled);
    writeTTYLine(completedLine, ctx);
    stepIndentById.delete(data.eventId);
  });

  emitter.on("stderr_line", (data) => {
    if (ctx.isTTY && ctx.runningInterval !== undefined) {
      process.stdout.write("\r\u001b[K\u001b[1A\r\u001b[K");
    }
    if (!ctx.isTTY) {
      process.stderr.write(`${data.line}\n`);
    }
    if (ctx.isTTY && ctx.runningInterval !== undefined) {
      const elapsedSec = (Date.now() - ctx.startedAt) / 1000;
      process.stdout.write(formatRunningBottomLine("default", elapsedSec));
    }
  });
}
