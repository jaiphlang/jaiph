#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.
# Thin aggregator: core API + sourced runtime submodules.

jaiph__version() {
  echo "jaiph 0.5.0"
}

jaiph__runtime_api() {
  echo "1"
}

jaiph__die() {
  local message="$1"
  echo "jaiph: $message" >&2
  return 1
}

# Portable file-lock primitives using mkdir (atomic on all POSIX systems).
# Used by inbox parallel dispatch to protect shared state files.
jaiph::_lock() {
  local lockdir="$1"
  local timeout_s="${JAIPH_LOCK_TIMEOUT_SECONDS:-30}"
  local sleep_s="${JAIPH_LOCK_SLEEP_SECONDS:-0.05}"
  case "$timeout_s" in
    ''|*[!0-9]*) timeout_s=30 ;;
  esac
  if [[ -z "$sleep_s" ]]; then
    sleep_s="0.05"
  fi
  local started_at="$SECONDS"
  while ! mkdir "$lockdir" 2>/dev/null; do
    # If owner pid is known and no longer alive, clear stale lock.
    if [[ -f "${lockdir}/pid" ]]; then
      local owner_pid
      owner_pid="$(<"${lockdir}/pid")"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -f "${lockdir}/pid" 2>/dev/null || true
        rmdir "$lockdir" 2>/dev/null || true
        continue
      fi
    fi
    if (( SECONDS - started_at >= timeout_s )); then
      echo "jaiph: lock timeout while waiting for ${lockdir}" >&2
      return 1
    fi
    sleep "$sleep_s"
  done
  printf '%s\n' "$$" > "${lockdir}/pid" 2>/dev/null || true
  return 0
}

jaiph::_unlock() {
  local lockdir="$1"
  rm -f "${lockdir}/pid" 2>/dev/null || true
  rmdir "$lockdir" 2>/dev/null || true
}

jaiph__expect_contain() {
  local haystack="$1"
  local needle="$2"
  if [[ -z "$needle" ]]; then
    return 0
  fi
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "jaiph: expectContain failed: expected to find:" >&2
    echo "---" >&2
    printf '%s\n' "$needle" >&2
    echo "---" >&2
    echo "in output (${#haystack} chars):" >&2
    echo "---" >&2
    printf '%s\n' "$haystack" | head -100 >&2
    echo "---" >&2
    return 1
  fi
  return 0
}

jaiph__expect_not_contain() {
  local haystack="$1"
  local needle="$2"
  if [[ -z "$needle" ]]; then
    return 0
  fi
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "jaiph: expectNotContain failed: did not expect to find:" >&2
    echo "---" >&2
    printf '%s\n' "$needle" >&2
    echo "---" >&2
    echo "in output (${#haystack} chars):" >&2
    echo "---" >&2
    printf '%s\n' "$haystack" | head -100 >&2
    echo "---" >&2
    return 1
  fi
  return 0
}

jaiph__expect_equal() {
  local actual="$1"
  local expected="$2"
  if [[ "$actual" != "$expected" ]]; then
    local gray=$'\e[90m'
    local red=$'\e[31m'
    local reset=$'\e[0m'
    echo "expectEqual failed:" >&2
    printf '%b- %s%b\n' "$gray" "$expected" "$reset" >&2
    printf '%b+ %s%b\n' "$red" "$actual" "$reset" >&2
    return 1
  fi
  return 0
}

# Runtime: step event emission and run summary.
# JSON building is owned by the JS kernel (emit.js); bash passes raw args.

# Resolve kernel/emit.js: prefer directory next to JAIPH_STDLIB (CLI always sets it) so we never
# depend on a fragile BASH_SOURCE path. Fall back to stdlib-adjacent runtime/kernel (e.g. tests).
_jaiph_emit_kernel_dir=""
if [[ -n "${JAIPH_STDLIB:-}" ]]; then
  _emit_js_candidate="$(cd "$(dirname "$JAIPH_STDLIB")" && pwd)/runtime/kernel/emit.js"
  if [[ -f "$_emit_js_candidate" ]]; then
    _jaiph_emit_kernel_dir="$(cd "$(dirname "$_emit_js_candidate")" && pwd)"
  fi
fi
if [[ -z "${_jaiph_emit_kernel_dir:-}" ]]; then
  _jaiph_emit_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/kernel"
fi
unset _emit_js_candidate

# Exported for child shells (e.g. jaiph::execute_readonly bash -c): they do not re-source stdlib,
# so unexported _jaiph_emit_kernel_dir would expand empty and break node "${dir}/emit.js".
export JAIPH_EMIT_JS="${_jaiph_emit_kernel_dir}/emit.js"

jaiph::timestamp_utc() {
  date -u +"%Y-%m-%dT%H-%M-%SZ"
}

jaiph::event_fd() {
  if (: >&3) 2>/dev/null; then
    printf "3"
    return 0
  fi
  printf "2"
}

jaiph::emit_workflow_summary_event() {
  local wf_type="$1"
  local wf_name="$2"
  if [[ -z "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    return 0
  fi
  node "${JAIPH_EMIT_JS}" workflow-event "$wf_type" "$wf_name"
}

jaiph::log() {
  local message="$*"
  local had_xtrace=0
  case "$-" in *x*) had_xtrace=1 ;; esac
  [[ "$had_xtrace" -eq 1 ]] && set +x
  JAIPH_EVENT_FD="$(jaiph::event_fd)" node "${JAIPH_EMIT_JS}" log "$message"
  echo -e "$message"
  [[ "$had_xtrace" -eq 1 ]] && set -x || true
}

jaiph::logerr() {
  local message="$*"
  local had_xtrace=0
  case "$-" in *x*) had_xtrace=1 ;; esac
  [[ "$had_xtrace" -eq 1 ]] && set +x
  JAIPH_EVENT_FD="$(jaiph::event_fd)" node "${JAIPH_EMIT_JS}" logerr "$message"
  echo -e "$message" >&2
  [[ -n "${JAIPH_ENSURE_OUTPUT_FILE:-}" ]] && printf '%s\n' "$message" >> "$JAIPH_ENSURE_OUTPUT_FILE"
  [[ "$had_xtrace" -eq 1 ]] && set -x || true
}

# Emit STEP_START or STEP_END event. Args:
#   event_type func_name step_kind status elapsed_ms out_file err_file step_id parent_id seq depth [param_args...]
# Environment (read by JS): JAIPH_RUN_ID, JAIPH_STEP_PARAM_KEYS, JAIPH_DISPATCH_CHANNEL,
# JAIPH_DISPATCH_SENDER, JAIPH_RUN_SUMMARY_FILE, JAIPH_SOURCE_FILE.
jaiph::emit_step_event() {
  local had_xtrace=0
  case "$-" in *x*) had_xtrace=1 ;; esac
  [[ "$had_xtrace" -eq 1 ]] && set +x
  JAIPH_EVENT_FD="$(jaiph::event_fd)" node "${JAIPH_EMIT_JS}" step-event "$@"
  [[ "$had_xtrace" -eq 1 ]] && set -x || true
}

# Runtime: test mode helpers (mocks, JAIPH_TEST_MODE).
jaiph::is_test_mode() {
  [[ "${JAIPH_TEST_MODE:-}" == "1" ]]
}

# Reads and consumes the first line from JAIPH_MOCK_RESPONSES_FILE.
# Outputs the line to stdout. Returns 0 if a line was read, 1 if no file or empty.
jaiph::read_next_mock_response() {
  if [[ -z "${JAIPH_MOCK_RESPONSES_FILE:-}" || ! -f "${JAIPH_MOCK_RESPONSES_FILE}" ]]; then
    echo "jaiph: no mock for prompt (JAIPH_MOCK_RESPONSES_FILE missing or not a file)" >&2
    return 1
  fi
  local line
  line="$(head -n 1 "${JAIPH_MOCK_RESPONSES_FILE}" 2>/dev/null)" || true
  if [[ -z "$line" ]]; then
    return 1
  fi
  if [[ -s "${JAIPH_MOCK_RESPONSES_FILE}" ]]; then
    tail -n +2 "${JAIPH_MOCK_RESPONSES_FILE}" > "${JAIPH_MOCK_RESPONSES_FILE}.tmp" 2>/dev/null && mv "${JAIPH_MOCK_RESPONSES_FILE}.tmp" "${JAIPH_MOCK_RESPONSES_FILE}" || true
  fi
  printf '%s' "$line"
  return 0
}

# Runs JAIPH_MOCK_DISPATCH_SCRIPT with prompt text as $1; outputs mock response to stdout.
# Returns 0 on success, 1 on failure (e.g. no match and no else).
jaiph::mock_dispatch() {
  local prompt_text="${1:-}"
  if [[ -z "${JAIPH_MOCK_DISPATCH_SCRIPT:-}" || ! -x "${JAIPH_MOCK_DISPATCH_SCRIPT}" ]]; then
    echo "jaiph: no mock for prompt (JAIPH_MOCK_DISPATCH_SCRIPT missing or not executable)" >&2
    return 1
  fi
  "$JAIPH_MOCK_DISPATCH_SCRIPT" "$prompt_text"
}

# Runtime: run tracking, step execution, and artifact writing.
_jaiph_run_step_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/kernel"
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
    JAIPH_STEP_SEQ="${JAIPH_STEP_SEQ:-0}"
    JAIPH_STEP_STACK="${JAIPH_STEP_STACK:-}"
    JAIPH_LAST_STEP_ID="${JAIPH_LAST_STEP_ID:-}"
    mkdir -p "$JAIPH_RUN_DIR"
    if [[ -n "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
      mkdir -p "$(dirname "$JAIPH_RUN_SUMMARY_FILE")"
      : >>"$JAIPH_RUN_SUMMARY_FILE"
    fi
    export JAIPH_STEP_SEQ JAIPH_STEP_STACK JAIPH_LAST_STEP_ID
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
    JAIPH_STEP_SEQ="$(( ${JAIPH_STEP_SEQ:-0} + 1 ))"
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
  filtered_err="${err_path}.filtered.${BASHPID:-$$}.${RANDOM}"
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
  local tmp_suffix
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
  tmp_suffix="${BASHPID:-$$}.${RANDOM}"
  out_tmp="${out_file}.tmp.${tmp_suffix}"
  err_tmp="${err_file}.tmp.${tmp_suffix}"
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
    prompt_final_tmp="${out_file}.final.tmp.${tmp_suffix}"
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

# Runtime: inbox dispatch for multi-agent workflows (file-backed transport via kernel/inbox.js).
# Resolve kernel/inbox.js: same rules as JAIPH_EMIT_JS.
_jaiph_inbox_kernel_dir=""
if [[ -n "${JAIPH_STDLIB:-}" ]]; then
  _inbox_js_candidate="$(cd "$(dirname "$JAIPH_STDLIB")" && pwd)/runtime/kernel/inbox.js"
  if [[ -f "$_inbox_js_candidate" ]]; then
    _jaiph_inbox_kernel_dir="$(cd "$(dirname "$_inbox_js_candidate")" && pwd)"
  fi
fi
if [[ -z "${_jaiph_inbox_kernel_dir:-}" ]]; then
  _jaiph_inbox_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/kernel"
fi
unset _inbox_js_candidate
export JAIPH_INBOX_JS="${_jaiph_inbox_kernel_dir}/inbox.js"

# Max dispatch iterations before aborting (guards against infinite circular sends).
JAIPH_INBOX_MAX_DISPATCH_DEPTH="${JAIPH_INBOX_MAX_DISPATCH_DEPTH:-100}"

# Initialise inbox state for the current run.
jaiph::inbox_init() {
  if [[ -z "${JAIPH_RUN_DIR:-}" ]]; then
    jaiph::init_run_tracking
  fi
  export JAIPH_INBOX_DIR="${JAIPH_RUN_DIR}/inbox"
  node "${JAIPH_INBOX_JS}" init || return $?
}

# Send a message to a channel.
# Usage: jaiph::send <channel> <content> [<sender>]
jaiph::send() {
  node "${JAIPH_INBOX_JS}" send "$1" "$2" "${3:-}" || return 1
}

# Register a routing rule: when a message arrives on <channel>, call the listed workflow functions.
# Usage: jaiph::register_route <channel> <func1> [<func2> ...]
jaiph::register_route() {
  local channel="$1"
  shift
  node "${JAIPH_INBOX_JS}" register-route "$channel" "$@" || return $?
}

# Drain the dispatch queue (see kernel/inbox.ts).
jaiph::drain_queue() {
  node "${JAIPH_INBOX_JS}" drain || return $?
}

# Runtime: prompt execution (agent invocation, stream parsing, test mocks).
# Prompt execution is delegated to the JS kernel (runtime/kernel/prompt.js).
_jaiph_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/kernel"

# Backward-compatible stream parser entry point (delegates to kernel).
jaiph::stream_json_to_text() {
  node "${_jaiph_kernel_dir}/stream-parser.js"
}

jaiph::prompt_impl() {
  local stdin_prompt prompt_text
  if [[ ! -t 0 ]]; then
    stdin_prompt="$(cat)"
  else
    stdin_prompt=""
  fi
  if [[ -n "$stdin_prompt" ]]; then
    prompt_text="$stdin_prompt"
  else
    prompt_text="$*"
  fi
  printf '%s' "$prompt_text" | node "${_jaiph_kernel_dir}/prompt.js"
}

jaiph::prompt() {
  jaiph::run_step jaiph::prompt prompt jaiph::prompt_impl "$@"
}

jaiph::prompt_capture() {
  local capture_file status
  capture_file="$(mktemp)"
  jaiph::prompt "$@" >"$capture_file"
  status=$?
  rm -f "$capture_file"
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  printf '%s' "${JAIPH_LAST_PROMPT_FINAL:-}"
}

# Typed prompt: run prompt, parse last line as JSON, validate against JAIPH_PROMPT_SCHEMA,
# output eval string to set JAIPH_PROMPT_CAPTURE_NAME and JAIPH_PROMPT_CAPTURE_NAME_field for each field.
# Stdin = prompt text. Exits: 0 = success; 1 = JSON parse error; 2 = missing required field; 3 = type mismatch.
jaiph::prompt_capture_with_schema() {
  local preview="$1"
  shift
  local prompt_text
  prompt_text="$(cat)"
  # Avoid a pipeline here: it runs the function in a subshell and would lose
  # JAIPH_LAST_PROMPT_FINAL plus exported typed fields in the parent shell.
  jaiph::prompt "$preview" "$@" <<< "$prompt_text"
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  local raw="${JAIPH_LAST_PROMPT_FINAL:-}"
  local schema="${JAIPH_PROMPT_SCHEMA:-}"
  local capture_name="${JAIPH_PROMPT_CAPTURE_NAME:-}"
  if [[ -z "$schema" || -z "$capture_name" ]]; then
    echo "jaiph: prompt_capture_with_schema: JAIPH_PROMPT_SCHEMA and JAIPH_PROMPT_CAPTURE_NAME must be set" >&2
    return 1
  fi
  local eval_line
  eval_line="$(printf '%s' "$raw" | JAIPH_PROMPT_SCHEMA="$schema" JAIPH_PROMPT_CAPTURE_NAME="$capture_name" node "${_jaiph_kernel_dir}/schema.js")"
  local node_status=$?
  if [[ "$node_status" -ne 0 ]]; then
    return "$node_status"
  fi
  eval "$eval_line"
}

# Runtime: read-only sandbox execution (unshare fallback and Linux mount namespace).
jaiph::execute_readonly() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph::execute_readonly requires a function name"
    return 1
  fi
  if ! declare -f "$func_name" >/dev/null 2>&1; then
    jaiph__die "unknown function: $func_name"
    return 1
  fi
  # Rules execute in child shells for readonly isolation.
  # Export all functions so rule bodies can call local helpers/shims.
  local exported_fn
  while IFS= read -r exported_fn; do
    export -f "$exported_fn" >/dev/null 2>&1 || true
  done < <(compgen -A function)
  export -f "$func_name"
  export -f jaiph__die
  export -f jaiph::prompt
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
  sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" JAIPH_EMIT_JS="$JAIPH_EMIT_JS" unshare -m bash -c '
    mount --make-rprivate /
    mount -o remount,ro /
    func_name="$1"
    shift || true
    "$func_name" "$@"
  ' _ "$func_name" "$@"
}

# Backwards-compatible top-level aliases for DSL convenience.
# Some compiled scripts may call `log`/`logerr` directly.
log() {
  jaiph::log "$@"
}

logerr() {
  jaiph::logerr "$@"
}

