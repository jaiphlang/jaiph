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

jaiph__stream_json_to_text() {
  node -e '
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const emit = (value) => {
      if (typeof value === "string" && value.length > 0) {
        process.stdout.write(value);
      }
    };
    const pick = (obj) => {
      if (!obj || typeof obj !== "object") return "";
      if (typeof obj.delta === "string") return obj.delta;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.output_text === "string") return obj.output_text;
      if (typeof obj.content === "string") return obj.content;
      if (obj.message && typeof obj.message.content === "string") return obj.message.content;
      if (Array.isArray(obj.choices) && obj.choices[0]) {
        const c = obj.choices[0];
        if (typeof c.text === "string") return c.text;
        if (c.delta && typeof c.delta.content === "string") return c.delta.content;
      }
      if (Array.isArray(obj.delta) && obj.delta.length > 0) {
        const first = obj.delta[0];
        if (first && typeof first.text === "string") return first.text;
      }
      if (Array.isArray(obj.content) && obj.content.length > 0) {
        const first = obj.content[0];
        if (first && typeof first.text === "string") return first.text;
      }
      return "";
    };
    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        emit(pick(JSON.parse(line)));
      } catch {
        process.stdout.write(`${line}\n`);
      }
    });
  '
}

jaiph__prompt__impl() {
  local workspace_root
  local agent_command
  local stdin_prompt
  local prompt_text
  workspace_root="$(jaiph__workspace_root)"
  agent_command="${JAIPH_AGENT_COMMAND:-cursor-agent}"
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
  if [[ -n "$prompt_text" ]]; then
    printf "Prompt:\n%s\n\n" "$prompt_text"
  fi
  if [[ -n "${JAIPH_AGENT_MODEL:-}" ]]; then
    "$agent_command" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --model "$JAIPH_AGENT_MODEL" --trust "$prompt_text" \
      | jaiph__stream_json_to_text
    return $?
  fi
  "$agent_command" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --trust "$prompt_text" \
    | jaiph__stream_json_to_text
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
  JAIPH_RUN_SUMMARY_FILE="$JAIPH_RUN_DIR/run_summary.jsonl"
  mkdir -p "$JAIPH_RUN_DIR"
  : >"$JAIPH_RUN_SUMMARY_FILE"
  export JAIPH_RUN_DIR JAIPH_PRECEDING_FILES JAIPH_RUN_SUMMARY_FILE
}

jaiph__track_output_files() {
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

jaiph__event_fd() {
  if (: >&3) 2>/dev/null; then
    printf "3"
    return 0
  fi
  printf "2"
}

jaiph__json_escape() {
  local raw="$1"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/\\n}"
  raw="${raw//$'\r'/\\r}"
  printf "%s" "$raw"
}

jaiph__step_identity() {
  local func_name="$1"
  if [[ "$func_name" == *"__workflow_"* ]]; then
    printf "workflow|%s" "${func_name##*__workflow_}"
    return 0
  fi
  if [[ "$func_name" == *"__rule_"* ]]; then
    printf "rule|%s" "${func_name##*__rule_}"
    return 0
  fi
  if [[ "$func_name" == *"__function_"* ]]; then
    printf "function|%s" "${func_name##*__function_}"
    return 0
  fi
  if [[ "$func_name" == "jaiph__prompt" ]]; then
    printf "prompt|prompt"
    return 0
  fi
  printf "step|%s" "$func_name"
}

jaiph__emit_step_event() {
  local event_type="$1"
  local func_name="$2"
  local status="${3:-}"
  local elapsed_ms="${4:-}"
  local out_file="${5:-}"
  local err_file="${6:-}"
  local timestamp kind name payload marker_fd
  local step_identity
  step_identity="$(jaiph__step_identity "$func_name")"
  kind="${step_identity%%|*}"
  name="${step_identity#*|}"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  payload="$(printf '{"type":"%s","func":"%s","kind":"%s","name":"%s","ts":"%s","status":%s,"elapsed_ms":%s,"out_file":"%s","err_file":"%s"}' \
    "$(jaiph__json_escape "$event_type")" \
    "$(jaiph__json_escape "$func_name")" \
    "$(jaiph__json_escape "$kind")" \
    "$(jaiph__json_escape "$name")" \
    "$(jaiph__json_escape "$timestamp")" \
    "${status:-null}" \
    "${elapsed_ms:-null}" \
    "$(jaiph__json_escape "$out_file")" \
    "$(jaiph__json_escape "$err_file")")"
  marker_fd="$(jaiph__event_fd)"
  printf "__JAIPH_EVENT__ %s\n" "$payload" >&"$marker_fd"
  if [[ "$event_type" == "STEP_END" && -n "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    printf "%s\n" "$payload" >>"$JAIPH_RUN_SUMMARY_FILE"
  fi
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
  local out_tmp err_tmp elapsed_ms
  step_started_seconds="$SECONDS"
  step_started_at="$(jaiph__timestamp_utc)"
  safe_name="$(jaiph__sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/${step_started_at}-${safe_name}.err"
  out_tmp="${out_file}.tmp.$$"
  err_tmp="${err_file}.tmp.$$"
  jaiph__emit_step_event "STEP_START" "$func_name"
  had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  "$@" >"$out_tmp" 2>"$err_tmp"
  status=$?
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
  jaiph__track_output_files "$out_file" "$err_file"
  step_elapsed_seconds="$((SECONDS - step_started_seconds))"
  elapsed_ms="$((step_elapsed_seconds * 1000))"
  jaiph__emit_step_event "STEP_END" "$func_name" "$status" "$elapsed_ms" "$out_file" "$err_file"
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
