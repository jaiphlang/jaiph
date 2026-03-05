# Runtime: step event emission and run summary.
# Sourced by jaiph_stdlib.sh. Depends on core (jaiph__die) from aggregator.

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

jaiph::json_escape() {
  local raw="$1"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/\\n}"
  raw="${raw//$'\r'/\\r}"
  printf "%s" "$raw"
}

jaiph::step_identity() {
  local func_name="$1"
  local name
  if [[ "$func_name" == *"::workflow::"* ]]; then
    name="${func_name##*::workflow::}"
    printf "workflow|%s" "${name%::impl}"
    return 0
  fi
  if [[ "$func_name" == *"::rule::"* ]]; then
    name="${func_name##*::rule::}"
    printf "rule|%s" "${name%::impl}"
    return 0
  fi
  if [[ "$func_name" == *"::function::"* ]]; then
    name="${func_name##*::function::}"
    printf "function|%s" "${name%::impl}"
    return 0
  fi
  if [[ "$func_name" == "jaiph::prompt" ]]; then
    printf "prompt|prompt"
    return 0
  fi
  printf "step|%s" "$func_name"
}

jaiph::emit_step_event() {
  local event_type="$1"
  local func_name="$2"
  local status="${3:-}"
  local elapsed_ms="${4:-}"
  local out_file="${5:-}"
  local err_file="${6:-}"
  local step_id="${7:-}"
  local parent_id="${8:-}"
  local seq="${9:-}"
  local depth="${10:-}"
  local run_id="${11:-${JAIPH_RUN_ID:-}}"
  local timestamp kind name payload marker_fd parent_json had_xtrace
  had_xtrace=0
  case "$-" in
    *x*) had_xtrace=1 ;;
  esac
  if [[ "$had_xtrace" -eq 1 ]]; then
    set +x
  fi
  local step_identity
  step_identity="$(jaiph::step_identity "$func_name")"
  kind="${step_identity%%|*}"
  name="${step_identity#*|}"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  parent_json="null"
  if [[ -n "$parent_id" ]]; then
    parent_json="\"$(jaiph::json_escape "$parent_id")\""
  fi
  payload="$(printf '{"type":"%s","func":"%s","kind":"%s","name":"%s","ts":"%s","status":%s,"elapsed_ms":%s,"out_file":"%s","err_file":"%s","id":"%s","parent_id":%s,"seq":%s,"depth":%s,"run_id":"%s"}' \
    "$(jaiph::json_escape "$event_type")" \
    "$(jaiph::json_escape "$func_name")" \
    "$(jaiph::json_escape "$kind")" \
    "$(jaiph::json_escape "$name")" \
    "$(jaiph::json_escape "$timestamp")" \
    "${status:-null}" \
    "${elapsed_ms:-null}" \
    "$(jaiph::json_escape "$out_file")" \
    "$(jaiph::json_escape "$err_file")" \
    "$(jaiph::json_escape "$step_id")" \
    "$parent_json" \
    "${seq:-null}" \
    "${depth:-null}" \
    "$(jaiph::json_escape "$run_id")")"
  marker_fd="$(jaiph::event_fd)"
  printf "__JAIPH_EVENT__ %s\n" "$payload" >&"$marker_fd"
  if [[ "$event_type" == "STEP_END" && -n "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    printf "%s\n" "$payload" >>"$JAIPH_RUN_SUMMARY_FILE"
  fi
  if [[ "$had_xtrace" -eq 1 ]]; then
    set -x
  fi
}
