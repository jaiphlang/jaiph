// Cross-platform process-tree termination.
//
// `jaiph run` launches the workflow leader detached (`workflow-launch.ts`), and
// the leader in turn spawns agent backends (`prompt.ts`) and script children,
// or a `docker run` child (`docker.ts`). Terminating a run cleanly means
// terminating that whole tree, not just the leader — otherwise backends and
// script children are orphaned.
//
// POSIX has a single primitive for this: a detached child is its own process
// group leader (pgid == pid), so `process.kill(-pid, signal)` delivers `signal`
// to every process in the group. Windows has no such primitive — a negative pid
// throws, and `child.kill()` / `process.kill(pid)` terminate only the leader.
// `killProcessTree` hides that difference behind one call site.

import { spawn, type ChildProcess } from "node:child_process";

/**
 * Test seam for the `taskkill` spawn. Swapped out in unit tests so the win32
 * branch can be exercised on any host without a real `taskkill` binary.
 */
export const _portability = {
  spawn(command: string, args: string[]): ChildProcess {
    return spawn(command, args, { stdio: "ignore" });
  },
};

/**
 * Terminate `pid` and its descendants with `signal`, portably.
 *
 * POSIX: `process.kill(-pid, signal)` signals the whole process group. If the
 * target is not a group leader the group does not exist (ESRCH) and we fall
 * back to signaling the single process, matching the pre-portability behavior.
 *
 * win32: negative-pid group kill is unsupported (it throws) and per-process
 * kill orphans children, so we spawn `taskkill /pid <pid> /T /F`, which force-
 * terminates the entire tree. If `taskkill` cannot be launched we degrade to a
 * per-process `process.kill(pid, signal)`. Because `taskkill /F` is already a
 * forceful kill with no graceful phase, a follow-up `SIGKILL` escalation after
 * a `SIGTERM`/`SIGINT` is a **documented no-op** — the tree is already gone.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    killProcessTreeWin32(pid, signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    killSingleProcess(pid, signal);
  }
}

function killProcessTreeWin32(pid: number, signal: NodeJS.Signals): void {
  // `taskkill /F` already force-killed the tree on the first (SIGTERM/SIGINT)
  // call, so the SIGKILL escalation has nothing left to terminate.
  if (signal === "SIGKILL") {
    return;
  }
  let child: ChildProcess;
  try {
    child = _portability.spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
  } catch {
    killSingleProcess(pid, signal);
    return;
  }
  // `spawn` reports a missing/unspawnable `taskkill` asynchronously via "error",
  // not by throwing — degrade to a per-process kill when that fires.
  child.once?.("error", () => killSingleProcess(pid, signal));
  child.unref?.();
}

function killSingleProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // no-op: process already gone or not signalable.
  }
}
