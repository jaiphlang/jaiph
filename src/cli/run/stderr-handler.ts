import { rewriteJaiphDiagnosticsLine, type SourceMapCache } from "../shared/jaiph-source-map";
import { parseStepEvent, parseLogEvent } from "./events";
import { colorize, formatStartLine, formatCompletedLine, formatHeartbeatLine } from "./display";
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

function handleLine(
  line: string,
  state: StderrParserState,
  emitter: RunEmitter,
  formatDiagnosticLine: (line: string) => string,
): void {
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
    emitter.emit("stderr_line", { line: formatDiagnosticLine(line) });
  }
}

export type StderrParserOptions = {
  /** Rewrite human-facing stderr (e.g. map generated `.sh` line numbers to `.jh` via `.jaiph.map`). */
  sourceMapCache?: SourceMapCache;
};

/** Create a line handler that parses stderr lines and emits events through the emitter. */
export function createStderrParser(emitter: RunEmitter, opts?: StderrParserOptions): (line: string) => void {
  const cache = opts?.sourceMapCache;
  const formatDiagnosticLine =
    cache !== undefined
      ? (ln: string) => rewriteJaiphDiagnosticsLine(ln, cache)
      : (ln: string) => ln;
  const state: StderrParserState = {
    runtimeStack: [], legacyStack: [], legacyCounter: 0, rootStepId: null,
  };
  return (line: string) => handleLine(line, state, emitter, formatDiagnosticLine);
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

export type NonTTYHeartbeatStep = {
  eventId: string;
  kind: string;
  name: string;
  indent: string;
  startedAt: number;
  lastHeartbeatAt: number;
  lastPrintedElapsedSec: number;
};

export type TTYContext = {
  isTTY: boolean;
  colorEnabled: boolean;
  startedAt: number;
  runningInterval: ReturnType<typeof setInterval> | undefined;
  nonTTYHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
  nonTTYHeartbeatStep: NonTTYHeartbeatStep | null;
};

function nonTTYHeartbeatFirstSec(): number {
  const raw = process.env.JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC;
  if (raw === undefined || raw === "") return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** Wall-clock interval between heartbeat lines (ms). Exported for `jaiph run` scheduling. */
export function nonTTYHeartbeatTickMs(): number {
  const raw = process.env.JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS;
  if (raw === undefined || raw === "") return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 250 ? n : 30_000;
}

/** Emit one gray heartbeat line if the current non-TTY step has run long enough (see env thresholds). */
export function tickNonTTYHeartbeat(ctx: TTYContext): void {
  if (ctx.isTTY) return;
  const step = ctx.nonTTYHeartbeatStep;
  if (step === null) return;
  const firstSec = nonTTYHeartbeatFirstSec();
  const tickMs = nonTTYHeartbeatTickMs();
  const now = Date.now();
  const elapsedSec = Math.floor((now - step.startedAt) / 1000);
  if (elapsedSec < firstSec) return;
  const isFirst = step.lastHeartbeatAt === 0;
  if (!isFirst) {
    if (now - step.lastHeartbeatAt < tickMs) return;
    if (elapsedSec <= step.lastPrintedElapsedSec) return;
  }
  step.lastHeartbeatAt = now;
  step.lastPrintedElapsedSec = elapsedSec;
  const dimEnabled = process.env.NO_COLOR === undefined;
  const line = formatHeartbeatLine(step.indent, step.kind, step.name, elapsedSec, dimEnabled);
  process.stdout.write(`${line}\n`);
}

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
  const nonTTYStack: NonTTYHeartbeatStep[] = [];

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
    if (!ctx.isTTY) {
      nonTTYStack.push({
        eventId: data.eventId,
        kind: data.event.kind,
        name: data.event.name,
        indent,
        startedAt: Date.now(),
        lastHeartbeatAt: 0,
        lastPrintedElapsedSec: -1,
      });
      ctx.nonTTYHeartbeatStep = nonTTYStack[nonTTYStack.length - 1] ?? null;
    }
    writeTTYLine(label, ctx);
  });

  emitter.on("step_end", (data) => {
    if (data.isRoot) return;
    const elapsedSec = Math.max(0, Math.floor((data.event.elapsed_ms ?? 0) / 1000));
    const fallbackDepth = Math.max(1, data.event.depth ?? 1);
    const indent = stepIndentById.get(data.eventId) ?? "  · ".repeat(fallbackDepth);
    const completedLine = formatCompletedLine(indent, data.event.status ?? 1, elapsedSec, ctx.colorEnabled, data.event.kind, data.event.name);
    writeTTYLine(completedLine, ctx);
    stepIndentById.delete(data.eventId);
    if (!ctx.isTTY) {
      const idx = nonTTYStack.findIndex((s) => s.eventId === data.eventId);
      if (idx !== -1) nonTTYStack.splice(idx, 1);
      ctx.nonTTYHeartbeatStep = nonTTYStack.length > 0 ? nonTTYStack[nonTTYStack.length - 1]! : null;
    }
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
