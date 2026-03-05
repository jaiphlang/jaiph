#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.

jaiph__version() {
  echo "jaiph 0.2.0"
}

jaiph__die() {
  local message="$1"
  echo "jai: $message" >&2
  return 1
}

jaiph__prompt() {
  cursor-agent "$@"
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

jaiph__init_run_tracking() {
  if [[ -n "${JAIPH_RUN_DIR:-}" ]]; then
    return 0
  fi
  local started_at run_id
  started_at="$(jaiph__timestamp_utc)"
  run_id="$(jaiph__new_run_id)"
  JAIPH_RUN_DIR="$PWD/${started_at}-${run_id}"
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
  local step_started_at safe_name out_file err_file status
  step_started_at="$(jaiph__timestamp_utc)"
  safe_name="$(jaiph__sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.err"
  "$@" >"$out_file" 2>"$err_file"
  status=$?
  jaiph__track_output_files "$out_file" "$err_file"
  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  fi
  if [[ -s "$err_file" ]]; then
    cat "$err_file" >&2
  fi
  return "$status"
}

# Wrapper to execute functions in a read-only filesystem sandbox.
jaiph__execute_readonly() {
  local func_name="$1"
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph__execute_readonly requires a function name"
    return 1
  fi
  if ! declare -f "$func_name" >/dev/null 2>&1; then
    jaiph__die "unknown function: $func_name"
    return 1
  fi
  if ! command -v unshare >/dev/null 2>&1; then
    jaiph__die "unshare is required for read-only rule execution"
    return 1
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    jaiph__die "sudo is required for read-only rule execution"
    return 1
  fi

  export -f "$func_name"
  export -f jaiph__die
  export -f jaiph__prompt
  sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" unshare -m bash -c "
    mount --make-rprivate /
    mount -o remount,ro /
    $func_name
  "
}
