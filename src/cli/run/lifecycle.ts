import { ChildProcess } from "node:child_process";

import { spawnJaiphWorkflowProcess } from "../../runtime/kernel/workflow-launch";

export function spawnRunProcess(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
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
  opts?: { forceKillAfterMs?: number },
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
    scheduleForceKill();
  };
  const handleTerminate = (): void => {
    terminateRunProcessGroup(child, "SIGTERM");
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
  onClose?: () => void,
): Promise<{ status: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    child.on("close", (code, signal) => {
      onClose?.();
      resolveExit({ status: typeof code === "number" ? code : 1, signal });
    });
  });
}
