import type { RuntimeEventEmitter } from "./runtime-event-emitter";

const DEFAULT_IDLE_WARN_SEC = 180;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

/** Seconds of silence before a leaf step emits a `LOGWARN` (`0` disables). */
export function parseStepIdleWarnSec(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_STEP_IDLE_WARN_SEC;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_WARN_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_WARN_SEC;
}

function checkIntervalMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const raw = env.JAIPH_STEP_IDLE_WARN_CHECK_MS;
  if (raw === undefined || raw === "") return DEFAULT_CHECK_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 250 ? Math.floor(n) : DEFAULT_CHECK_INTERVAL_MS;
}

export type StepIdleOutputWarn = {
  bump: () => void;
  stop: () => void;
};

export type StepIdleOutputWarnOpts = {
  checkIntervalMs?: number;
};

/**
 * Warn once per idle period when a leaf step stops emitting stdout/stderr.
 * Resets the warn latch on the next output chunk so a second stall can warn again.
 */
export function createStepIdleOutputWarn(
  emitter: RuntimeEventEmitter,
  kind: string,
  name: string,
  env: NodeJS.ProcessEnv,
  opts?: StepIdleOutputWarnOpts,
): StepIdleOutputWarn | null {
  const idleWarnSec = parseStepIdleWarnSec(env);
  if (idleWarnSec <= 0) return null;

  let lastOutputAt = Date.now();
  let idleWarned = false;
  const tickMs = checkIntervalMs(env, opts?.checkIntervalMs);
  const timer = setInterval(() => {
    const idleSec = Math.floor((Date.now() - lastOutputAt) / 1000);
    if (idleSec >= idleWarnSec && !idleWarned) {
      idleWarned = true;
      emitter.emitLog("LOGWARN", `${kind} ${name}: no output for ${idleSec}s`);
    }
  }, tickMs);
  timer.unref?.();

  return {
    bump() {
      lastOutputAt = Date.now();
      idleWarned = false;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
