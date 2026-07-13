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
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Test seams. Swapped out in unit tests so the win32 branches can be exercised
 * on any host without a real `taskkill` binary or a real `sh.exe` on disk.
 */
export const _portability = {
  spawn(command: string, args: string[]): ChildProcess {
    return spawn(command, args, { stdio: "ignore" });
  },
  /** Existence probe for `resolveShell` PATH / Git-for-Windows lookups. */
  fileExists(path: string): boolean {
    return existsSync(path);
  },
  /** Reset the memoized shell so a test can re-run resolution under a new platform. */
  resetShellCache(): void {
    cachedShell = undefined;
  },
};

let cachedShell: string | undefined;

/**
 * Resolve the POSIX shell used to run inline workflow shell lines and hooks.
 *
 * Jaiph's language semantics require POSIX `sh` on every platform — inline
 * lines are never translated to cmd/PowerShell, or workflows stop being
 * portable. On POSIX the answer is simply `sh`. On win32 there is no `sh` on
 * the default PATH, so we locate Git for Windows' bundled `sh.exe`, first on
 * PATH and then in the standard install locations. The result is memoized for
 * the lifetime of the process.
 */
export function resolveShell(): string {
  if (cachedShell !== undefined) return cachedShell;
  cachedShell = process.platform === "win32" ? resolveWindowsPosixShell() : "sh";
  return cachedShell;
}

function resolveWindowsPosixShell(): string {
  // PATH first: honor an sh.exe the user already put on their PATH.
  const path = process.env.PATH ?? "";
  for (const dir of path.split(";")) {
    if (!dir) continue;
    const candidate = join(dir, "sh.exe");
    if (_portability.fileExists(candidate)) return candidate;
  }
  // Then the standard Git for Windows layouts under each known install root.
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];
  for (const root of roots) {
    if (!root) continue;
    for (const rel of [join("Git", "bin", "sh.exe"), join("Git", "usr", "bin", "sh.exe")]) {
      const candidate = join(root, rel);
      if (_portability.fileExists(candidate)) return candidate;
    }
  }
  throw new Error(
    "E_NO_POSIX_SHELL Jaiph requires a POSIX `sh` to run inline shell lines and hooks, " +
      "but `sh.exe` was not found on PATH or in the standard Git for Windows install " +
      "locations. Install Git for Windows (https://git-scm.com/download/win), which " +
      "bundles `sh.exe`.",
  );
}

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
