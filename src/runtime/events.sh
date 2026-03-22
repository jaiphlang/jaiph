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
  local kind="${2:-}"
  if [[ -n "$kind" ]]; then
    # Kind is passed explicitly by the compiler; extract name from flat symbol.
    local name="${func_name##*::}"
    name="${name%::impl}"
    printf "%s|%s" "$kind" "$name"
    return 0
  fi
  if [[ "$func_name" == "jaiph::prompt" ]]; then
    printf "prompt|prompt"
    return 0
  fi
  printf "step|%s" "$func_name"
}

# Build JSON array of [key, value] pairs for step params. Uses JAIPH_STEP_PARAM_KEYS (comma-separated)
# and positional args "$@" as values when set; each arg is expected to be "key=value" and we strip
# the key prefix to get the display value. When JAIPH_STEP_PARAM_KEYS is not set, uses arg1, arg2, ...
# for "$@" as positional param names.
jaiph::step_params_json() {
  local keys="${JAIPH_STEP_PARAM_KEYS:-}"
  local args=("$@")
  local result="["
  local i
  local _sj_first=1
  if [[ -n "$keys" ]]; then
    local old_ifs="$IFS"
    IFS=',' read -r -a keyarr <<< "$keys"
    IFS="$old_ifs"
    for ((i = 0; i < ${#keyarr[@]}; i++)); do
      local key="${keyarr[i]}"
      key="$(jaiph::json_escape "$key")"
      local arg="${args[i]:-}"
      # Strip "key=" prefix so value may contain =
      local val="${arg#${keyarr[i]}=}"
      val="$(jaiph::json_escape "$val")"
      if [[ $_sj_first -eq 0 ]]; then result+=","; fi
      _sj_first=0
      result+="[\"$key\",\"$val\"]"
    done
  else
    for ((i = 0; i < ${#args[@]}; i++)); do
      local key="arg$((i + 1))"
      local val="${args[i]:-}"
      val="$(jaiph::json_escape "$val")"
      if [[ $_sj_first -eq 0 ]]; then result+=","; fi
      _sj_first=0
      result+="[\"$key\",\"$val\"]"
    done
  fi
  result+="]"
  printf "%s" "$result"
}

jaiph::log() {
  local message="$*"
  local depth
  depth="$(jaiph::step_stack_depth)"
  local marker_fd payload had_xtrace
  had_xtrace=0
  case "$-" in
    *x*) had_xtrace=1 ;;
  esac
  if [[ "$had_xtrace" -eq 1 ]]; then
    set +x
  fi
  payload="$(printf '{"type":"LOG","message":"%s","depth":%s}' \
    "$(jaiph::json_escape "$message")" \
    "$depth")"
  marker_fd="$(jaiph::event_fd)"
  printf "__JAIPH_EVENT__ %s\n" "$payload" >&"$marker_fd"
  echo "$message"
  if [[ "$had_xtrace" -eq 1 ]]; then
    set -x
  fi
}

jaiph::logerr() {
  local message="$*"
  local depth
  depth="$(jaiph::step_stack_depth)"
  local marker_fd payload had_xtrace
  had_xtrace=0
  case "$-" in
    *x*) had_xtrace=1 ;;
  esac
  if [[ "$had_xtrace" -eq 1 ]]; then
    set +x
  fi
  payload="$(printf '{"type":"LOGERR","message":"%s","depth":%s}' \
    "$(jaiph::json_escape "$message")" \
    "$depth")"
  marker_fd="$(jaiph::event_fd)"
  printf "__JAIPH_EVENT__ %s\n" "$payload" >&"$marker_fd"
  echo "$message" >&2
  if [[ "$had_xtrace" -eq 1 ]]; then
    set -x
  fi
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
  local params_json="${12:-}"
  local step_kind="${13:-}"
  local timestamp kind name payload marker_fd parent_json had_xtrace
  had_xtrace=0
  case "$-" in
    *x*) had_xtrace=1 ;;
  esac
  if [[ "$had_xtrace" -eq 1 ]]; then
    set +x
  fi
  local step_identity
  step_identity="$(jaiph::step_identity "$func_name" "$step_kind")"
  kind="${step_identity%%|*}"
  name="${step_identity#*|}"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  parent_json="null"
  if [[ -n "$parent_id" ]]; then
    parent_json="\"$(jaiph::json_escape "$parent_id")\""
  fi
  if [[ -n "$params_json" ]]; then
    payload="$(printf '{"type":"%s","func":"%s","kind":"%s","name":"%s","ts":"%s","status":%s,"elapsed_ms":%s,"out_file":"%s","err_file":"%s","id":"%s","parent_id":%s,"seq":%s,"depth":%s,"run_id":"%s","params":%s}' \
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
      "$(jaiph::json_escape "$run_id")" \
      "$params_json")"
  else
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
  fi
  # Append dispatched/channel/sender metadata if set by inbox dispatch.
  if [[ -n "${JAIPH_DISPATCH_CHANNEL:-}" ]]; then
    local _dispatch_extra=",\"dispatched\":true,\"channel\":\"$(jaiph::json_escape "$JAIPH_DISPATCH_CHANNEL")\""
    if [[ -n "${JAIPH_DISPATCH_SENDER:-}" ]]; then
      _dispatch_extra+=",\"sender\":\"$(jaiph::json_escape "$JAIPH_DISPATCH_SENDER")\""
    fi
    payload="${payload%\}}${_dispatch_extra}}"
  fi
  # Always embed out_content (and err_content for failed steps) in STEP_END
  # events so the CLI can display output without reading files from disk.
  # This is the single source of truth for step output in both Docker and
  # non-Docker modes.  Content is capped at 1 MB to keep event payloads sane;
  # the full output remains in out_file/err_file on disk for debugging.
  local _jaiph_max_embed=1048576  # 1 MB
  if [[ "$event_type" == "STEP_END" ]]; then
    local embed_extra=""
    if [[ -n "$out_file" && -f "$out_file" ]]; then
      local out_content
      out_content="$(<"$out_file")"
      if [[ "${#out_content}" -gt "$_jaiph_max_embed" ]]; then
        out_content="${out_content:0:$_jaiph_max_embed}
[truncated]"
      fi
      embed_extra="${embed_extra},\"out_content\":\"$(jaiph::json_escape "$out_content")\""
    fi
    if [[ -n "$err_file" && -f "$err_file" && "${status:-0}" != "0" ]]; then
      local err_content
      err_content="$(<"$err_file")"
      if [[ "${#err_content}" -gt "$_jaiph_max_embed" ]]; then
        err_content="${err_content:0:$_jaiph_max_embed}
[truncated]"
      fi
      embed_extra="${embed_extra},\"err_content\":\"$(jaiph::json_escape "$err_content")\""
    fi
    if [[ -n "$embed_extra" ]]; then
      payload="${payload%\}}${embed_extra}}"
    fi
  fi
  marker_fd="$(jaiph::event_fd)"
  printf "__JAIPH_EVENT__ %s\n" "$payload" >&"$marker_fd"
  if [[ "$event_type" == "STEP_END" && -n "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    # Some workflows (notably CI/e2e cleanup) may remove .jaiph/runs while a
    # run is still active; recreate parent dir so summary append does not fail.
    mkdir -p "$(dirname "$JAIPH_RUN_SUMMARY_FILE")" 2>/dev/null || true
    printf "%s\n" "$payload" >>"$JAIPH_RUN_SUMMARY_FILE"
  fi
  if [[ "$had_xtrace" -eq 1 ]]; then
    set -x
  fi
}
