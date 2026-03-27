# Runtime: step event emission and run summary.
# Sourced by jaiph_stdlib.sh. Depends on core (jaiph__die) from aggregator.
# JSON building is owned by the JS kernel (emit.js); bash passes raw args.

# Resolve kernel/emit.js: prefer directory next to JAIPH_STDLIB (CLI always sets it) so we never
# depend on a fragile BASH_SOURCE path. Fall back to this file's .../runtime/kernel (e.g. tests).
_jaiph_emit_kernel_dir=""
if [[ -n "${JAIPH_STDLIB:-}" ]]; then
  _emit_js_candidate="$(cd "$(dirname "$JAIPH_STDLIB")" && pwd)/runtime/kernel/emit.js"
  if [[ -f "$_emit_js_candidate" ]]; then
    _jaiph_emit_kernel_dir="$(cd "$(dirname "$_emit_js_candidate")" && pwd)"
  fi
fi
if [[ -z "${_jaiph_emit_kernel_dir:-}" ]]; then
  _jaiph_emit_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kernel"
fi
unset _emit_js_candidate

# Exported for child shells (e.g. jaiph::execute_readonly bash -c): they do not re-source this file,
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
