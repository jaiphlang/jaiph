// Cross-platform process-tree termination.
//
// `jaiph run` launches the workflow leader detached (`workflow-launch.ts`), and
// the leader in turn spawns agent backends (`prompt.ts`) and script children.
// Terminating a run cleanly means terminating that whole tree, not just the
// leader — otherwise backends and script children are orphaned.
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

/**
 * Whether ANSI SGR colors and cursor/erase sequences may be emitted.
 *
 * Single policy for the whole CLI: ANSI is on only when writing to a TTY and
 * `NO_COLOR` is unset (https://no-color.org). Live status rendering, the
 * progress tree, and error formatting route their `isTTY && NO_COLOR` gate
 * through here so the rule lives in one place rather than being re-derived at
 * each emission site.
 *
 * On Windows 10+ Node enables VT processing on the console automatically, so
 * `isTTY` is a sufficient proxy for ANSI support — no extra win32 branch.
 */
export function canUseAnsi(stream: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;
}

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
    "E_NO_POSIX_SHELL Jaiph requires a POSIX `sh` to run hooks, " +
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

/**
 * Send `SIGTERM` to the process tree now, then escalate to `SIGKILL` after
 * `graceMs` if anything survives. The escalation timer is `unref`d so it never
 * keeps the event loop alive on its own. On win32 the SIGKILL escalation is a
 * documented no-op (see {@link killProcessTree}).
 */
export function killProcessTreeEscalating(pid: number, graceMs = 5000): void {
  killProcessTree(pid, "SIGTERM");
  const escalate = setTimeout(() => {
    killProcessTree(pid, "SIGKILL");
  }, graceMs);
  escalate.unref?.();
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

// --- Leader-spawned child process groups -----------------------------------
//
// The leader spawns two kinds of child it may terminate mid-flight: `script`
// subprocesses (`spawnAndCapture` in `node-workflow-runtime.ts`) and agent
// backends (`runBackend` in `prompt-backends.ts`). The idle-output kill and the
// prompt watchdog terminate one of those with `killProcessTree`, whose POSIX
// group kill (`process.kill(-pid, …)`) only reaches the child's subtree when the
// child leads its own group (`pgid == pid`). A child spawned without
// `detached: true` shares the leader's group, so `-pid` names a non-existent
// group (ESRCH) and only the single pid is signalled — its grandchildren
// survive. So on POSIX those children are spawned `detached: true`.
//
// The cost of detaching is that they no longer share the leader's group, so a
// SIGINT/SIGTERM delivered to the leader's group (Ctrl-C, or the CLI run-timeout
// kill in `lifecycle.ts`) no longer reaches them. `trackChildGroup` records each
// live child group and installs a one-time leader handler that forwards the
// received signal to every tracked group and then — mirroring the CLI's own
// escalation of the leader group — SIGKILLs those groups after a short grace, so
// a descendant that ignores the first signal (a shell backgrounds async jobs
// with SIGINT/SIGQUIT ignored) still dies. Windows has no process groups, so both
// the detach and the tracking are POSIX-only and win32 behaviour is unchanged.

/**
 * Whether a leader-spawned child should be put in its own process group.
 * POSIX only: on win32 there is no process group to kill and `detached` changes
 * console semantics, so it stays `false` and behaviour is unchanged.
 */
export const spawnInOwnGroup = process.platform !== "win32";

/**
 * Grace before the leader SIGKILLs a child group that ignored the forwarded
 * signal. Must stay below the CLI's own leader-group force-kill grace
 * (`forceKillAfterMs`, default 1500ms in `src/cli/run/lifecycle.ts`): the leader
 * must land its SIGKILL and re-raise before the CLI force-kills it, after which
 * it can no longer signal the detached groups. A group that drains earlier (the
 * common case — the child dies on the first signal) is detected by polling and
 * the leader re-raises at once, so a clean Ctrl-C is not delayed by this grace.
 */
const CHILD_GROUP_FORCE_KILL_MS = 1200;
const CHILD_GROUP_POLL_MS = 50;

/** Live child-group leader pids (pgid == pid) the leader may need to signal. */
const liveChildGroups = new Set<number>();
let signalForwardingInstalled = false;
let terminationPending = false;

/**
 * True once the leader has received SIGINT/SIGTERM and is forwarding it to the
 * child groups before terminating itself. The runner entry (`runCli`) checks
 * this so it does not `process.exit(status)` out from under the handler, which
 * must re-raise the signal so the leader dies *by signal* (preserving the host
 * call's "terminated by signal" result and matching pre-detach behaviour).
 */
export function isLeaderTerminationPending(): boolean {
  return terminationPending;
}

/**
 * Record `child` as a live process group and ensure the leader forwards
 * SIGINT/SIGTERM to every live group. No-op on win32 (no process groups) and
 * when the child has no pid (a failed spawn, or a unit-test fake). The pid is
 * dropped on the child's `exit` and `close` so a reused pid is never signalled.
 */
export function trackChildGroup(child: ChildProcess): void {
  if (process.platform === "win32") return;
  const pid = child.pid;
  if (typeof pid !== "number") return;
  liveChildGroups.add(pid);
  const forget = (): void => {
    liveChildGroups.delete(pid);
  };
  child.once("exit", forget);
  child.once("close", forget);
  installChildGroupSignalForwarding();
}

/** Whether process group `pgid` still has any live member (ESRCH ⇒ drained). */
function childGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: the group exists but we may not signal it (not expected for a
    // same-user child) — treat as alive. ESRCH: no member left — drained.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * On the first tracked group, install SIGINT/SIGTERM handlers. Installed at most
 * once per process.
 */
function installChildGroupSignalForwarding(): void {
  if (signalForwardingInstalled) return;
  signalForwardingInstalled = true;
  forwardToChildGroupsOnSignal("SIGINT");
  forwardToChildGroupsOnSignal("SIGTERM");
}

/**
 * Forward `signal` to every live child group, then re-raise it on the leader so
 * the leader dies *by signal* — but only after the groups have drained, so a
 * descendant that ignores the first signal (a shell sets a backgrounded job's
 * SIGINT/SIGQUIT to ignore) is SIGKILLed first rather than orphaned. The groups
 * are snapshotted because a group's leader pid is forgotten when it exits even
 * while a grandchild keeps the group alive; the group persists by pgid, so the
 * snapshot still names it. Polling re-raises as soon as every group is gone, so
 * the common case (the child dies at once) is not delayed. Removing our listener
 * first means a second identical signal (Ctrl-C again) hits the default
 * disposition and kills the leader immediately.
 */
function forwardToChildGroupsOnSignal(signal: "SIGINT" | "SIGTERM"): void {
  const handler = (): void => {
    process.removeListener(signal, handler);
    terminationPending = true;
    const groups = [...liveChildGroups];
    for (const pid of groups) {
      killProcessTree(pid, signal);
    }
    const reraise = (): void => {
      process.kill(process.pid, signal);
    };
    const deadline = Date.now() + CHILD_GROUP_FORCE_KILL_MS;
    const poll = (): void => {
      if (!groups.some(childGroupAlive)) {
        reraise();
        return;
      }
      if (Date.now() >= deadline) {
        for (const pid of groups) killProcessTree(pid, "SIGKILL");
        reraise();
        return;
      }
      // Referenced (not unref'd): keep the leader alive until it has resolved the
      // groups and re-raised, so a grandchild is never orphaned by an early exit.
      setTimeout(poll, CHILD_GROUP_POLL_MS);
    };
    poll();
  };
  process.on(signal, handler);
}
