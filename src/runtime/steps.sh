# Runtime: run tracking, step execution, and artifact writing.
# Sourced by jaiph_stdlib.sh. Depends on events.sh and test-mode.sh.

_jaiph_run_step_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kernel"
export _jaiph_run_step_kernel_dir

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
    # The run directory can be removed during long workflows (e.g. test cleanup).
    # Recreate it so subsequent step artifacts/events can still be written.
    mkdir -p "$JAIPH_RUN_DIR"
    if [[ -n "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
      mkdir -p "$(dirname "$JAIPH_RUN_SUMMARY_FILE")"
      : >>"$JAIPH_RUN_SUMMARY_FILE"
    fi
    return 0
  fi
  local run_id workspace_root runs_root
  local date_part time_part source_file candidate suffix
  run_id="$(jaiph::new_run_id)"
  workspace_root="$(jaiph::workspace_root)"
  date_part="$(date +%Y-%m-%d)"
  time_part="$(date +%H-%M-%S)"
  source_file="${JAIPH_SOURCE_FILE:-run}"
  if [[ -n "${JAIPH_RUNS_DIR:-}" ]]; then
    if [[ "$JAIPH_RUNS_DIR" = /* ]]; then
      runs_root="${JAIPH_RUNS_DIR}"
    else
      runs_root="${workspace_root}/${JAIPH_RUNS_DIR}"
    fi
  else
    runs_root="$workspace_root/.jaiph/runs"
  fi
  candidate="${runs_root}/${date_part}/${time_part}-${source_file}"
  if [[ -d "$candidate" ]]; then
    suffix=2
    while [[ -d "${candidate}-${suffix}" ]]; do
      suffix="$((suffix + 1))"
    done
    candidate="${candidate}-${suffix}"
  fi
  JAIPH_RUN_DIR="$candidate"
  JAIPH_PRECEDING_FILES=""
  JAIPH_RUN_SUMMARY_FILE="$JAIPH_RUN_DIR/run_summary.jsonl"
  JAIPH_RUN_ID="$run_id"
  JAIPH_STEP_SEQ=0
  JAIPH_STEP_STACK=""
  JAIPH_LAST_STEP_ID=""
  mkdir -p "$JAIPH_RUN_DIR"
  printf '%s' "0" >"$JAIPH_RUN_DIR/.seq"
  : >"$JAIPH_RUN_SUMMARY_FILE"
  export JAIPH_RUN_DIR JAIPH_PRECEDING_FILES JAIPH_RUN_SUMMARY_FILE JAIPH_RUN_ID JAIPH_STEP_SEQ JAIPH_STEP_STACK JAIPH_LAST_STEP_ID
}

jaiph::step_stack_depth() {
  if [[ -z "${JAIPH_STEP_STACK:-}" ]]; then
    printf "0"
    return 0
  fi
  local old_ifs="$IFS"
  IFS=","
  read -r -a ids <<<"${JAIPH_STEP_STACK}"
  IFS="$old_ifs"
  printf "%s" "${#ids[@]}"
}

jaiph::step_stack_peek() {
  if [[ -z "${JAIPH_STEP_STACK:-}" ]]; then
    printf ""
    return 0
  fi
  local old_ifs="$IFS"
  IFS=","
  read -r -a ids <<<"${JAIPH_STEP_STACK}"
  IFS="$old_ifs"
  printf "%s" "${ids[$((${#ids[@]} - 1))]}"
}

jaiph::step_stack_push() {
  local step_id="$1"
  if [[ -z "${JAIPH_STEP_STACK:-}" ]]; then
    JAIPH_STEP_STACK="$step_id"
  else
    JAIPH_STEP_STACK="${JAIPH_STEP_STACK},${step_id}"
  fi
  export JAIPH_STEP_STACK
}

jaiph::step_stack_pop() {
  if [[ -z "${JAIPH_STEP_STACK:-}" ]]; then
    return 0
  fi
  local old_ifs="$IFS"
  IFS=","
  read -r -a ids <<<"${JAIPH_STEP_STACK}"
  IFS="$old_ifs"
  if [[ "${#ids[@]}" -le 1 ]]; then
    JAIPH_STEP_STACK=""
    export JAIPH_STEP_STACK
    return 0
  fi
  JAIPH_STEP_STACK=""
  local i
  for ((i = 0; i < ${#ids[@]} - 1; i += 1)); do
    if [[ -z "$JAIPH_STEP_STACK" ]]; then
      JAIPH_STEP_STACK="${ids[$i]}"
    else
      JAIPH_STEP_STACK="${JAIPH_STEP_STACK},${ids[$i]}"
    fi
  done
  export JAIPH_STEP_STACK
}

jaiph::next_step_id() {
  local seq_file="${JAIPH_RUN_DIR:+${JAIPH_RUN_DIR}/.seq}"
  local _locked=0
  if [[ "${JAIPH_INBOX_PARALLEL:-}" == "true" && -n "$seq_file" ]]; then
    if ! jaiph::_lock "${seq_file}.lock"; then
      return 1
    fi
    _locked=1
  fi
  if [[ -n "$seq_file" && -f "$seq_file" ]]; then
    JAIPH_STEP_SEQ="$(( $(<"$seq_file") + 1 ))"
  else
    JAIPH_STEP_SEQ="$((JAIPH_STEP_SEQ + 1))"
  fi
  if [[ -n "$seq_file" ]]; then
    printf '%s' "$JAIPH_STEP_SEQ" >"$seq_file"
  fi
  if [[ "$_locked" -eq 1 ]]; then
    jaiph::_unlock "${seq_file}.lock"
  fi
  JAIPH_LAST_STEP_ID="${JAIPH_RUN_ID:-run}:${BASHPID:-$$}:${JAIPH_STEP_SEQ}"
  export JAIPH_LAST_STEP_ID
  export JAIPH_STEP_SEQ
}

jaiph::forward_nested_events_from_err() {
  local err_path="$1"
  if [[ -z "$err_path" || ! -f "$err_path" ]]; then
    return 0
  fi
  local marker_fd filtered_err line
  marker_fd="$(jaiph::event_fd)"
  filtered_err="${err_path}.filtered.$$"
  : >"$filtered_err"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "__JAIPH_EVENT__ "* ]]; then
      printf "%s\n" "$line" >&"$marker_fd"
    else
      printf "%s\n" "$line" >>"$filtered_err"
    fi
  done <"$err_path"
  mv "$filtered_err" "$err_path"
}

jaiph::track_output_files() {
  local file
  for file in "$@"; do
    if [[ -z "$file" ]]; then
      continue
    fi
    if [[ -z "${JAIPH_PRECEDING_FILES:-}" ]]; then
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

# Execute a script in an isolated environment: only essential system vars and
# JAIPH_LIB / JAIPH_SCRIPTS / JAIPH_WORKSPACE are passed through.
jaiph::_exec_script_isolated() {
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-}" \
    TERM="${TERM:-}" \
    USER="${USER:-}" \
    JAIPH_LIB="${JAIPH_LIB:-}" \
    JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-}" \
    JAIPH_WORKSPACE="${JAIPH_WORKSPACE:-}" \
    "$@"
}

jaiph::set_return_value() {
  if [[ -n "${JAIPH_RETURN_VALUE_FILE:-}" ]]; then
    printf '%s' "$1" > "$JAIPH_RETURN_VALUE_FILE"
  fi
}

jaiph::run_step() {
  local func_name="$1"
  local step_kind="${2:-}"
  shift 2 || shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph::run_step requires a function name"
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    jaiph__die "jaiph::run_step requires a command to execute"
    return 1
  fi
  jaiph::init_run_tracking || return 1
  local safe_name out_file err_file status had_errexit step_started_seconds step_elapsed_seconds
  local out_tmp err_tmp elapsed_ms prompt_final_tmp
  local step_id parent_id depth step_seq seq_prefix
  local prompt_writes_live_out=0
  local step_writes_live=0
  local jaiph__prompt_used_tee=0
  local _jaiph_rs_tee=0
  step_started_seconds="$SECONDS"
  jaiph::next_step_id
  step_id="$JAIPH_LAST_STEP_ID"
  step_seq="$JAIPH_STEP_SEQ"
  printf -v seq_prefix "%06d" "$step_seq"
  safe_name="$(jaiph::sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/${seq_prefix}-${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/${seq_prefix}-${safe_name}.err"
  out_tmp="${out_file}.tmp.$$"
  err_tmp="${err_file}.tmp.$$"
  prompt_final_tmp=""
  parent_id="$(jaiph::step_stack_peek)"
  depth="$(jaiph::step_stack_depth)"
  jaiph::step_stack_push "$step_id"
  jaiph::emit_step_event "STEP_START" "$func_name" "$step_kind" "" "" "" "" "$step_id" "$parent_id" "$step_seq" "$depth" "$@"
  unset JAIPH_STEP_PARAM_KEYS 2>/dev/null || true
  had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  local mock_script
  mock_script="$(jaiph::mock_script_for_symbol "$func_name")" || true
  if [[ -n "$mock_script" && -x "$mock_script" ]]; then
    ( "$mock_script" "$@" >"$out_tmp" 2>"$err_tmp" )
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
    # When stdout is a pipe (e.g. command substitution `x=$(...)` capturing a nested
    # workflow), duplicating prompt transcript via tee pollutes the capture. Write
    # only to the step .out file; parent workflow stdout still aggregates when fd 1
    # is a regular file (typical `run_step` subshell redirect).
    if [[ -p /dev/fd/1 ]]; then
      JAIPH_PROMPT_FINAL_FILE="$prompt_final_tmp" "$@" 2>"$err_tmp" >"$out_file"
      status=$?
    else
      jaiph__prompt_used_tee=1
      # Prompt output should be visible in the final .out file while streaming.
      JAIPH_PROMPT_FINAL_FILE="$prompt_final_tmp" "$@" 2>"$err_tmp" | tee "$out_file"
      status="${PIPESTATUS[0]}"
    fi
    prompt_writes_live_out=1
    if [[ -f "$prompt_final_tmp" ]]; then
      JAIPH_LAST_PROMPT_FINAL="$(<"$prompt_final_tmp")"
      rm -f "$prompt_final_tmp"
    else
      JAIPH_LAST_PROMPT_FINAL=""
    fi
    export JAIPH_LAST_PROMPT_FINAL
  else
    _jaiph_rs_tee=0
    if [[ "${JAIPH_STDOUT_SAVED:-}" == "1" ]] && ! jaiph::is_test_mode && ! [[ /dev/fd/1 -ef /dev/fd/7 ]] && ! [[ /dev/fd/1 -ef /dev/fd/8 ]]; then
      _jaiph_rs_tee=1
    fi
    export JAIPH_RUN_STEP_USE_TEE="$_jaiph_rs_tee"
    export JAIPH_RUN_STEP_OUT_TMP="$out_tmp"
    export JAIPH_RUN_STEP_ERR_TMP="$err_tmp"
    # Tell the kernel which parent fd carries __JAIPH_EVENT__ (2 or 3). Avoids mistaking our own
    # open() fds for the event stream when wiring nested bash stdio.
    env JAIPH_RUN_STEP_KERNEL_EXTRA_FD="$(jaiph::event_fd)" \
      node "${_jaiph_run_step_kernel_dir}/run-step-exec.js" "$func_name" "$step_kind" "$@"
    status=$?
  fi
  if [[ "$had_errexit" -eq 1 ]]; then
    set -e
  fi
  if [[ "$step_writes_live" -eq 1 ]]; then
    jaiph::forward_nested_events_from_err "$err_file"
  else
    jaiph::forward_nested_events_from_err "$err_tmp"
  fi
  if [[ "$prompt_writes_live_out" -eq 1 || "$step_writes_live" -eq 1 ]]; then
    if [[ ! -s "$out_file" ]]; then
      rm -f "$out_file"
      out_file=""
    fi
  elif [[ -s "$out_tmp" ]]; then
    mv "$out_tmp" "$out_file"
  else
    rm -f "$out_tmp"
    out_file=""
  fi
  if [[ "$step_writes_live" -eq 1 ]]; then
    if [[ ! -s "$err_file" ]]; then
      rm -f "$err_file"
      err_file=""
    fi
  elif [[ -s "$err_tmp" ]]; then
    mv "$err_tmp" "$err_file"
  else
    rm -f "$err_tmp"
    err_file=""
  fi
  if [[ "$step_kind" == "script" && -n "${JAIPH_RETURN_VALUE_FILE:-}" ]]; then
    if [[ -n "$out_file" && -f "$out_file" ]]; then
      cat "$out_file" >> "$JAIPH_RETURN_VALUE_FILE"
    else
      : > "$JAIPH_RETURN_VALUE_FILE"
    fi
  fi
  # Append step output to the ensure/recover output capture file.
  # .out is appended for all step kinds (scripts AND rules) so that rule-level
  # echo/log output is included in the recover payload.
  # .err is appended only for scripts: rule .err files contain catted nested
  # stderr (run_step cats failed child .err to parent stderr), so appending
  # rule .err would duplicate script stderr already captured at the leaf level.
  # Rule-level logerr output is captured directly by jaiph::logerr.
  if [[ -n "${JAIPH_ENSURE_OUTPUT_FILE:-}" ]]; then
    [[ -n "$out_file" && -f "$out_file" ]] && cat "$out_file" >> "$JAIPH_ENSURE_OUTPUT_FILE"
    if [[ "$step_kind" == "script" ]]; then
      [[ -n "$err_file" && -f "$err_file" ]] && cat "$err_file" >> "$JAIPH_ENSURE_OUTPUT_FILE"
    fi
  fi
  jaiph::track_output_files "$out_file" "$err_file"
  step_elapsed_seconds="$((SECONDS - step_started_seconds))"
  elapsed_ms="$((step_elapsed_seconds * 1000))"
  jaiph::emit_step_event "STEP_END" "$func_name" "$step_kind" "$status" "$elapsed_ms" "$out_file" "$err_file" "$step_id" "$parent_id" "$step_seq" "$depth"
  jaiph::step_stack_pop
  # In test mode, emit step output so test capture (e.g. response = w.default) can read it.
  # In normal runs, step output remains in .out artifacts unless the step itself streams live.
  # - Prompt + tee: transcript already went to stdout; avoid duplicate cat.
  # - Prompt + file-only (stdout is a pipe, e.g. nested cmdsub): cat would pollute the capture
  #   (engineer pick_role = run classify); skip. When stdout is a regular file (workflow subshell),
  #   cat still aggregates step logs for jaiph test.
  if jaiph::is_test_mode && [[ -n "$out_file" && -f "$out_file" ]]; then
    if [[ "$func_name" == "jaiph::prompt" ]]; then
      if [[ "$jaiph__prompt_used_tee" -eq 1 ]]; then
        :
      elif [[ -p /dev/fd/1 ]]; then
        :
      else
        cat "$out_file"
      fi
    else
      cat "$out_file"
    fi
  fi
  if [[ "$status" -ne 0 ]] && [[ -n "$err_file" && -f "$err_file" ]]; then
    if jaiph::is_test_mode; then
      if [[ -n "${JAIPH_TEST_CAPTURE_FILE:-}" ]]; then
        cat "$err_file" >>"$JAIPH_TEST_CAPTURE_FILE" 2>/dev/null || true
      fi
      cat "$err_file"
    else
      cat "$err_file" >&2
    fi
  fi
  return "$status"
}

# Variant that preserves command stdout/stderr while still emitting step events.
jaiph::run_step_passthrough() {
  local func_name="$1"
  local step_kind="${2:-}"
  shift 2 || shift || true
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
  local step_id parent_id depth step_seq
  step_started_seconds="$SECONDS"
  jaiph::next_step_id
  step_id="$JAIPH_LAST_STEP_ID"
  step_seq="$JAIPH_STEP_SEQ"
  parent_id="$(jaiph::step_stack_peek)"
  depth="$(jaiph::step_stack_depth)"
  jaiph::step_stack_push "$step_id"
  jaiph::emit_step_event "STEP_START" "$func_name" "$step_kind" "" "" "" "" "$step_id" "$parent_id" "$step_seq" "$depth" "$@"
  unset JAIPH_STEP_PARAM_KEYS 2>/dev/null || true
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
  jaiph::emit_step_event "STEP_END" "$func_name" "$step_kind" "$status" "$elapsed_ms" "" "" "$step_id" "$parent_id" "$step_seq" "$depth"
  jaiph::step_stack_pop
  return "$status"
}
