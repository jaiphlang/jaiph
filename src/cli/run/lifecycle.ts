import { ChildProcess } from "node:child_process";

import { spawnJaiphWorkflowProcess, killProcessTree } from "../../runtime";

export function spawnRunProcess(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: "pipe" | "inherit" },
): ChildProcess {
  return spawnJaiphWorkflowProcess(args, options);
}

export function terminateRunProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  killProcessTree(pid, signal);
}

/**
 * Terminate a run child on demand (not via a process signal): SIGINT the whole
 * process tree, then force-kill with SIGKILL if it has not exited after a grace
 * period — the same escalation `setupRunSignalHandlers` applies to CLI signals.
 * The force-kill timer is unref'd (never keeps the parent alive) and cleared
 * once the child exits. Used to cancel an in-flight `jaiph mcp` tool call.
 */
export function cancelRunProcess(
  child: ChildProcess,
  opts?: { forceKillAfterMs?: number },
): void {
  const forceKillAfterMs = opts?.forceKillAfterMs ?? 1500;
  terminateRunProcessGroup(child, "SIGINT");
  const forceKillTimer = setTimeout(() => {
    terminateRunProcessGroup(child, "SIGKILL");
  }, forceKillAfterMs);
  forceKillTimer.unref?.();
  child.once("exit", () => clearTimeout(forceKillTimer));
}

/**
 * Parse the parent-enforced host-mode wall-clock run timeout
 * (`JAIPH_RUN_TIMEOUT`, seconds). Unset / empty / non-numeric / `<= 0` disables
 * it (returns `0`), preserving the prior host behaviour where only a manual
 * SIGINT/SIGTERM stops a run. Docker mode uses its own `JAIPH_DOCKER_TIMEOUT`
 * enforced inside `spawnDockerProcess`; this covers the host spawn.
 */
export function parseRunTimeoutSeconds(
  env: Record<string, string | undefined>,
): number {
  const raw = env.JAIPH_RUN_TIMEOUT;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Arm a parent-enforced wall-clock timeout on a host run child. On expiry it
 * terminates the whole process group with SIGTERM and escalates to SIGKILL
 * after a grace period — the same escalation `setupRunSignalHandlers` applies to
 * CLI signals — so a host/`--unsafe` run that exceeds the budget is stopped
 * without a manual Ctrl-C.
 *
 * `timeoutSeconds <= 0` (disabled) returns an inert handle. The timer is cleared
 * automatically once the child exits, and `cancel()` clears both timers so a
 * completed run leaves nothing pending.
 */
export function armRunTimeout(
  child: ChildProcess,
  timeoutSeconds: number,
  opts?: { forceKillAfterMs?: number; onTimeout?: () => void },
): { cancel: () => void; timedOut: () => boolean } {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return { cancel: () => {}, timedOut: () => false };
  }
  const forceKillAfterMs = opts?.forceKillAfterMs ?? 1500;
  let didTimeout = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    didTimeout = true;
    terminateRunProcessGroup(child, "SIGTERM");
    opts?.onTimeout?.();
    forceKillTimer = setTimeout(() => {
      terminateRunProcessGroup(child, "SIGKILL");
      forceKillTimer = undefined;
    }, forceKillAfterMs);
    forceKillTimer.unref?.();
  }, timeoutSeconds * 1000);
  const cancel = (): void => {
    clearTimeout(timer);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };
  child.once("exit", cancel);
  return { cancel, timedOut: () => didTimeout };
}

export function setupRunSignalHandlers(
  child: ChildProcess,
  opts?: { forceKillAfterMs?: number; onSignalCleanup?: () => void },
): { remove: () => void } {
  const forceKillAfterMs = opts?.forceKillAfterMs ?? 1500;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const scheduleForceKill = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    forceKillTimer = setTimeout(() => {
      terminateRunProcessGroup(child, "SIGKILL");
      forceKillTimer = undefined;
    }, forceKillAfterMs);
  };
  const handleInterrupt = (): void => {
    terminateRunProcessGroup(child, "SIGINT");
    opts?.onSignalCleanup?.();
    scheduleForceKill();
  };
  const handleTerminate = (): void => {
    terminateRunProcessGroup(child, "SIGTERM");
    opts?.onSignalCleanup?.();
    scheduleForceKill();
  };
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTerminate);
  const remove = (): void => {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTerminate);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };
  return { remove };
}

export function waitForRunExit(
  child: ChildProcess,
  onClosed?: () => void,
  opts?: { closeGraceMs?: number },
): Promise<{ status: number; signal: NodeJS.Signals | null }> {
  const closeGraceMs = opts?.closeGraceMs ?? 1000;
  return new Promise((resolveExit) => {
    let done = false;
    let closeTimer: NodeJS.Timeout | undefined;
    let exitResult: { status: number; signal: NodeJS.Signals | null } | undefined;
    const finish = (result: { status: number; signal: NodeJS.Signals | null }): void => {
      if (done) return;
      done = true;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      child.removeListener("exit", handleExit);
      child.removeListener("close", handleClose);
      onClosed?.();
      resolveExit(result);
    };
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitResult = { status: typeof code === "number" ? code : 1, signal };
      if (closeGraceMs <= 0) {
        finish(exitResult);
        return;
      }
      closeTimer = setTimeout(() => {
        if (exitResult) {
          finish(exitResult);
        }
      }, closeGraceMs);
    };
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ status: typeof code === "number" ? code : 1, signal });
    };
    child.on("exit", handleExit);
    child.on("close", handleClose);
  });
}
