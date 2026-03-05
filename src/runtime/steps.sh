# Runtime: run tracking, step execution, and artifact writing.
# Sourced by jaiph_stdlib.sh. Depends on events.sh and test-mode.sh.

jaiph::new_run_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr "[:upper:]" "[:lower:]"
    return 0
  fi
  printf "%s-%s-%s" "$$" "$RANDOM" "$(date +%s)"
}

jaiph::sanitize_name() {
  local raw="$1"
  raw="${raw//[^[:alnum:]_.-]/_}"
  printf "%s" "$raw"
}

jaiph::workspace_root() {
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

jaiph::init_run_tracking() {
  if [[ -n "${JAIPH_RUN_DIR:-}" ]]; then
    return 0
  fi
  local started_at run_id workspace_root
  started_at="$(jaiph::timestamp_utc)"
  run_id="$(jaiph::new_run_id)"
  workspace_root="$(jaiph::workspace_root)"
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
  JAIPH_RUN_SUMMARY_FILE="$JAIPH_RUN_DIR/run_summary.jsonl"
  mkdir -p "$JAIPH_RUN_DIR"
  : >"$JAIPH_RUN_SUMMARY_FILE"
  export JAIPH_RUN_DIR JAIPH_PRECEDING_FILES JAIPH_RUN_SUMMARY_FILE
}

jaiph::track_output_files() {
  local file
  for file in "$@"; do
    if [[ -z "$file" ]]; then
      continue
    fi
    if [[ -z "$JAIPH_PRECEDING_FILES" ]]; then
      JAIPH_PRECEDING_FILES="$file"
    else
      JAIPH_PRECEDING_FILES="${JAIPH_PRECEDING_FILES},${file}"
    fi
  done
  export JAIPH_PRECEDING_FILES
}

# If in test mode and JAIPH_MOCK_SCRIPTS_DIR has a script for the given symbol, print its path and return 0.
# Otherwise print nothing and return 1.
jaiph::mock_script_for_symbol() {
  local func_name="${1:-}"
  if [[ -z "$func_name" ]]; then
    return 1
  fi
  if ! jaiph::is_test_mode; then
    return 1
  fi
  if [[ -z "${JAIPH_MOCK_SCRIPTS_DIR:-}" || ! -d "${JAIPH_MOCK_SCRIPTS_DIR}" ]]; then
    return 1
  fi
  local safe_name
  safe_name="$(jaiph::sanitize_name "$func_name")"
  local script_path="${JAIPH_MOCK_SCRIPTS_DIR}/${safe_name}"
  if [[ -x "$script_path" ]]; then
    printf '%s' "$script_path"
    return 0
  fi
  return 1
}

jaiph::run_step() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph::run_step requires a function name"
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    jaiph__die "jaiph::run_step requires a command to execute"
    return 1
  fi
  jaiph::init_run_tracking || return 1
  local step_started_at safe_name out_file err_file status had_errexit step_started_seconds step_elapsed_seconds
  local out_tmp err_tmp elapsed_ms prompt_final_tmp
  step_started_seconds="$SECONDS"
  step_started_at="$(jaiph::timestamp_utc)"
  safe_name="$(jaiph::sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.err"
  out_tmp="${out_file}.tmp.$$"
  err_tmp="${err_file}.tmp.$$"
  prompt_final_tmp=""
  jaiph::emit_step_event "STEP_START" "$func_name"
  had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  local mock_script
  mock_script="$(jaiph::mock_script_for_symbol "$func_name")" || true
  if [[ -n "$mock_script" && -x "$mock_script" ]]; then
    "$mock_script" "$@" >"$out_tmp" 2>"$err_tmp"
    status=$?
    if [[ "$func_name" == "jaiph::prompt" ]]; then
      if [[ -f "$out_tmp" ]]; then
        JAIPH_LAST_PROMPT_FINAL="$(<"$out_tmp")"
      else
        JAIPH_LAST_PROMPT_FINAL=""
      fi
      export JAIPH_LAST_PROMPT_FINAL
    fi
  elif [[ "$func_name" == "jaiph::prompt" ]]; then
    prompt_final_tmp="${out_file}.final.tmp.$$"
    JAIPH_PROMPT_FINAL_FILE="$prompt_final_tmp" "$@" 2>"$err_tmp" | tee "$out_tmp"
    status="${PIPESTATUS[0]}"
    if [[ -f "$prompt_final_tmp" ]]; then
      JAIPH_LAST_PROMPT_FINAL="$(<"$prompt_final_tmp")"
      rm -f "$prompt_final_tmp"
    else
      JAIPH_LAST_PROMPT_FINAL=""
    fi
    export JAIPH_LAST_PROMPT_FINAL
  else
    "$@" >"$out_tmp" 2>"$err_tmp"
    status=$?
  fi
  if [[ "$had_errexit" -eq 1 ]]; then
    set -e
  fi
  if [[ -s "$out_tmp" ]]; then
    mv "$out_tmp" "$out_file"
  else
    rm -f "$out_tmp"
    out_file=""
  fi
  if [[ -s "$err_tmp" ]]; then
    mv "$err_tmp" "$err_file"
  else
    rm -f "$err_tmp"
    err_file=""
  fi
  jaiph::track_output_files "$out_file" "$err_file"
  step_elapsed_seconds="$((SECONDS - step_started_seconds))"
  elapsed_ms="$((step_elapsed_seconds * 1000))"
  jaiph::emit_step_event "STEP_END" "$func_name" "$status" "$elapsed_ms" "$out_file" "$err_file"
  if [[ -n "$out_file" && -f "$out_file" ]]; then
    cat "$out_file"
  fi
  return "$status"
}

# Variant that preserves command stdout/stderr while still emitting step events.
jaiph::run_step_passthrough() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph::run_step_passthrough requires a function name"
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    jaiph__die "jaiph::run_step_passthrough requires a command to execute"
    return 1
  fi
  jaiph::init_run_tracking || return 1
  local status had_errexit step_started_seconds step_elapsed_seconds elapsed_ms
  step_started_seconds="$SECONDS"
  jaiph::emit_step_event "STEP_START" "$func_name"
  had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  local mock_script
  mock_script="$(jaiph::mock_script_for_symbol "$func_name")" || true
  if [[ -n "$mock_script" && -x "$mock_script" ]]; then
    "$mock_script" "$@"
    status=$?
  else
    "$@"
    status=$?
  fi
  if [[ "$had_errexit" -eq 1 ]]; then
    set -e
  fi
  step_elapsed_seconds="$((SECONDS - step_started_seconds))"
  elapsed_ms="$((step_elapsed_seconds * 1000))"
  jaiph::emit_step_event "STEP_END" "$func_name" "$status" "$elapsed_ms" "" ""
  return "$status"
}
