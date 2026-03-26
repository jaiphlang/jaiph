# Runtime: prompt execution (agent invocation, stream parsing, test mocks).
# Sourced by jaiph_stdlib.sh. Depends on steps.sh and test-mode.sh.
# Prompt execution is delegated to the JS kernel (kernel/prompt.js).

# Resolve kernel directory at source time (before _jaiph_runtime_dir is unset).
_jaiph_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kernel"

# Backward-compatible stream parser entry point (delegates to kernel).
# Tests and external code may call this directly via `source prompt.sh`.
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
