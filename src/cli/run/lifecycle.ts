import { spawn, ChildProcess } from "node:child_process";

export function buildRunWrapperCommand(): string {
  const command = [
    'meta_file="$1"; shift',
    'built_script="$1"; shift',
    'workflow_symbol="$1"; shift',
    "__jaiph_status=0",
    "jaiph__write_meta() {",
    "  local status_value=\"$1\"",
    '  if [[ -n "${meta_file:-}" ]]; then',
    '    printf "status=%s\\n" "$status_value" > "$meta_file"',
    '    printf "run_dir=%s\\n" "${JAIPH_RUN_DIR:-}" >> "$meta_file"',
    '    printf "summary_file=%s\\n" "${JAIPH_RUN_SUMMARY_FILE:-}" >> "$meta_file"',
    "  fi",
    "}",
    'trap \'__jaiph_status=$?; jaiph__write_meta "$__jaiph_status"\' EXIT',
    "exec 3>&2",
    'source "$built_script"',
    'entrypoint="${workflow_symbol}::default"',
    'if ! declare -F "$entrypoint" >/dev/null; then',
    '  echo "jaiph run requires workflow \'default\' in the input file" >&2',
    "  exit 1",
    "fi",
    'if [[ "${JAIPH_DEBUG:-}" == "true" ]]; then',
    "  set -x",
    "fi",
    '"$entrypoint" "$@"',
  ].join("\n");
  return command;
}

export function spawnRunProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  return spawn("bash", ["-c", command, "jaiph-run", ...args], {
    stdio: "pipe",
    cwd: options.cwd,
    env: options.env,
    detached: true,
  });
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
