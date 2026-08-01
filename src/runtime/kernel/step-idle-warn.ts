import type { RuntimeEventEmitter } from "./runtime-event-emitter";

const DEFAULT_IDLE_WARN_SEC = 180;
const DEFAULT_IDLE_KILL_SEC = 3600;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

/** Seconds of silence before a leaf step emits a `LOGWARN` (`0` disables). */
export function parseStepIdleWarnSec(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_STEP_IDLE_WARN_SEC;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_WARN_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_WARN_SEC;
}

/** Seconds of silence before a leaf step is terminated with `LOGERR` (`0` disables). */
export function parseStepIdleKillSec(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_STEP_IDLE_KILL_SEC;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_KILL_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_KILL_SEC;
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
  /**
   * When provided, the tracker also enforces the idle-kill threshold
   * (`JAIPH_STEP_IDLE_KILL_SEC`, default 3600s, `0` disables). After that long
   * without new output the tracker emits a `LOGERR` naming the step and idle
   * duration, invokes this callback exactly once (the caller terminates the
   * leaf step), and stops. Absent this callback the tracker is warn-only.
   */
  onIdleKill?: (idleSec: number) => void;
};

/**
 * Track leaf-step output silence off a single idle clock, reset on the next
 * stdout/stderr chunk via `bump()`:
 *
 *  - Warn: emit a `LOGWARN` every `JAIPH_STEP_IDLE_WARN_SEC` while silent
 *    (180s, 360s, 540s, …).
 *  - Kill: when `opts.onIdleKill` is provided, emit a single `LOGERR` after
 *    `JAIPH_STEP_IDLE_KILL_SEC` (default 3600s) of silence and invoke the
 *    callback so the caller terminates the step. The two cadences are
 *    independent; the kill fires at most once.
 *
 * Returns `null` when both cadences are disabled (nothing to track).
 */
export function createStepIdleOutputWarn(
  emitter: RuntimeEventEmitter,
  kind: string,
  name: string,
  env: NodeJS.ProcessEnv,
  opts?: StepIdleOutputWarnOpts,
): StepIdleOutputWarn | null {
  const idleWarnSec = parseStepIdleWarnSec(env);
  const idleKillSec = opts?.onIdleKill ? parseStepIdleKillSec(env) : 0;
  const warnEnabled = idleWarnSec > 0;
  const killEnabled = idleKillSec > 0 && opts?.onIdleKill !== undefined;
  if (!warnEnabled && !killEnabled) return null;

  let lastOutputAt = Date.now();
  let nextWarnAtSec = idleWarnSec;
  let killed = false;
  const tickMs = checkIntervalMs(env, opts?.checkIntervalMs);
  const timer = setInterval(() => {
    const idleSec = Math.floor((Date.now() - lastOutputAt) / 1000);
    // Kill takes precedence: once the hard threshold is crossed the step is
    // going away, so emit the LOGERR, hand off to the caller, and stop ticking.
    if (killEnabled && !killed && idleSec >= idleKillSec) {
      killed = true;
      emitter.emitLog(
        "LOGERR",
        `${kind} ${name}: no new output for ${idleSec}s; terminating idle step`,
      );
      clearInterval(timer);
      opts!.onIdleKill!(idleSec);
      return;
    }
    if (warnEnabled && idleSec >= nextWarnAtSec) {
      emitter.emitLog("LOGWARN", `${kind} ${name}: no new output for ${idleSec}s`);
      nextWarnAtSec += idleWarnSec;
    }
  }, tickMs);
  timer.unref?.();

  return {
    bump() {
      if (killed) return;
      lastOutputAt = Date.now();
      nextWarnAtSec = idleWarnSec;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
