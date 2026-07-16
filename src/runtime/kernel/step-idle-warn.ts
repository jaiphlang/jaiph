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
 * Emit a `LOGWARN` every `JAIPH_STEP_IDLE_WARN_SEC` while a leaf step stays silent
 * (180s, 360s, 540s, …). Resets the cadence on the next stdout/stderr chunk.
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
  let nextWarnAtSec = idleWarnSec;
  const tickMs = checkIntervalMs(env, opts?.checkIntervalMs);
  const timer = setInterval(() => {
    const idleSec = Math.floor((Date.now() - lastOutputAt) / 1000);
    if (idleSec >= nextWarnAtSec) {
      emitter.emitLog("LOGWARN", `${kind} ${name}: no new output for ${idleSec}s`);
      nextWarnAtSec += idleWarnSec;
    }
  }, tickMs);
  timer.unref?.();

  return {
    bump() {
      lastOutputAt = Date.now();
      nextWarnAtSec = idleWarnSec;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
