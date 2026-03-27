import { spawn, ChildProcess } from "node:child_process";

/**
 * Bash snippet that sources a transpiled workflow module and invokes
 * `<workflow_symbol>::default`. Invoked as:
 * `bash -c '<snippet>' jaiph-run <meta_file> <built_script> <workflow_symbol> [run_args...]`
 *
 * The CLI process group targets this bash leader (detached) so SIGINT/SIGTERM
 * reach kernel subprocesses. Orchestration is TypeScript-owned; workflow
 * semantics still execute in the transpiled shell module with Node kernel helpers.
 */
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

/** Spawn the detached bash workflow leader used by `jaiph run` (and Docker with the same wrapper). */
export function spawnJaiphWorkflowProcess(
  positionalArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const command = buildRunWrapperCommand();
  return spawn("bash", ["-c", command, "jaiph-run", ...positionalArgs], {
    stdio: "pipe",
    cwd: options.cwd,
    env: options.env,
    detached: true,
  });
}
