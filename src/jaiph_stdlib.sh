#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.

jaiph__version() {
  echo "jaiph 0.0.1"
}

jaiph__runtime_api() {
  echo "1"
}

jaiph__die() {
  local message="$1"
  echo "jai: $message" >&2
  return 1
}

jaiph__prompt__impl() {
  local workspace_root
  local agent_command
  workspace_root="$(jaiph__workspace_root)"
  agent_command="${JAIPH_AGENT_COMMAND:-cursor-agent}"
  if [[ "$#" -gt 0 ]]; then
    printf "Prompt:\n%s\n\n" "$*"
  fi
  if [[ -n "${JAIPH_AGENT_MODEL:-}" ]]; then
    "$agent_command" --print --output-format text --workspace "$workspace_root" --model "$JAIPH_AGENT_MODEL" --trust "$@"
    return $?
  fi
  "$agent_command" --print --output-format text --workspace "$workspace_root" --trust "$@"
}

jaiph__prompt() {
  jaiph__run_step jaiph__prompt jaiph__prompt__impl "$@"
}

jaiph__new_run_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr "[:upper:]" "[:lower:]"
    return 0
  fi
  printf "%s-%s-%s" "$$" "$RANDOM" "$(date +%s)"
}

jaiph__sanitize_name() {
  local raw="$1"
  raw="${raw//[^[:alnum:]_.-]/_}"
  printf "%s" "$raw"
}

jaiph__timestamp_utc() {
  date -u +"%Y-%m-%dT%H-%M-%SZ"
}

jaiph__workspace_root() {
  if [[ -n "${JAIPH_WORKSPACE:-}" ]]; then
    printf "%s" "$JAIPH_WORKSPACE"
    return 0
  fi
  local current="$PWD"
  while [[ "$current" != "/" ]]; do
    if [[ -d "$current/.jaiph" || -d "$current/.git" ]]; then
      printf "%s" "$current"
      return 0
    fi
    current="$(dirname "$current")"
  done
  printf "%s" "$PWD"
}

jaiph__init_run_tracking() {
  if [[ -n "${JAIPH_RUN_DIR:-}" ]]; then
    return 0
  fi
  local started_at run_id workspace_root
  started_at="$(jaiph__timestamp_utc)"
  run_id="$(jaiph__new_run_id)"
  workspace_root="$(jaiph__workspace_root)"
  if [[ -n "${JAIPH_RUNS_DIR:-}" ]]; then
    if [[ "$JAIPH_RUNS_DIR" = /* ]]; then
      JAIPH_RUN_DIR="${JAIPH_RUNS_DIR}/${started_at}-${run_id}"
    else
      JAIPH_RUN_DIR="${workspace_root}/${JAIPH_RUNS_DIR}/${started_at}-${run_id}"
    fi
  else
    JAIPH_RUN_DIR="$workspace_root/.jaiph/runs/${started_at}-${run_id}"
  fi
  JAIPH_PRECEDING_FILES=""
  mkdir -p "$JAIPH_RUN_DIR"
  export JAIPH_RUN_DIR JAIPH_PRECEDING_FILES
}

jaiph__track_output_files() {
  local out_file="$1"
  local err_file="$2"
  if [[ -z "$JAIPH_PRECEDING_FILES" ]]; then
    JAIPH_PRECEDING_FILES="${out_file},${err_file}"
  else
    JAIPH_PRECEDING_FILES="${JAIPH_PRECEDING_FILES},${out_file},${err_file}"
  fi
  export JAIPH_PRECEDING_FILES
}

jaiph__run_step() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph__run_step requires a function name"
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    jaiph__die "jaiph__run_step requires a command to execute"
    return 1
  fi
  jaiph__init_run_tracking || return 1
  local step_started_at safe_name out_file err_file status had_errexit step_started_seconds step_elapsed_seconds
  step_started_seconds="$SECONDS"
  step_started_at="$(jaiph__timestamp_utc)"
  safe_name="$(jaiph__sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.err"
  had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  "$@" >"$out_file" 2>"$err_file"
  status=$?
  if [[ "$had_errexit" -eq 1 ]]; then
    set -e
  fi
  jaiph__track_output_files "$out_file" "$err_file"
  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  fi
  if [[ -s "$err_file" ]]; then
    cat "$err_file" >&2
  fi
  step_elapsed_seconds="$((SECONDS - step_started_seconds))"
  local marker_fd=2
  if (: >&3) 2>/dev/null; then
    marker_fd=3
  fi
  printf "__JAIPH_STEP_END__|%s|%s|%s\n" "$func_name" "$status" "$step_elapsed_seconds" >&"$marker_fd"
  return "$status"
}

# Wrapper to execute functions in a read-only filesystem sandbox.
jaiph__execute_readonly() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph__execute_readonly requires a function name"
    return 1
  fi
  if ! declare -f "$func_name" >/dev/null 2>&1; then
    jaiph__die "unknown function: $func_name"
    return 1
  fi
  export -f "$func_name"
  export -f jaiph__die
  export -f jaiph__prompt
  if ! command -v unshare >/dev/null 2>&1 || ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1 || ! unshare -m true >/dev/null 2>&1; then
    # Best-effort fallback for environments without Linux mount namespace tooling (e.g. macOS).
    # Execute in a child shell so "exit" inside a rule does not terminate the parent runner.
    bash -c '
      func_name="$1"
      shift || true
      "$func_name" "$@"
    ' _ "$func_name" "$@"
    return $?
  fi
  sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" unshare -m bash -c '
    mount --make-rprivate /
    mount -o remount,ro /
    func_name="$1"
    shift || true
    "$func_name" "$@"
  ' _ "$func_name" "$@"
}
