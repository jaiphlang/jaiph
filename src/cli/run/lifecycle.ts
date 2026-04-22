import { ChildProcess } from "node:child_process";

import { spawnJaiphWorkflowProcess } from "../../runtime/kernel/workflow-launch";

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
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // no-op
    }
  }
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
