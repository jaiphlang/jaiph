# Runtime: prompt execution (agent invocation, stream parsing, test mocks).
# Sourced by jaiph_stdlib.sh. Depends on steps.sh and test-mode.sh.

jaiph::stream_json_to_text() {
  node -e '
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let currentSection = "";
    let wroteAny = false;
    let lastChar = "";
    const writeRaw = (value) => {
      if (typeof value === "string" && value.length > 0) {
        process.stdout.write(value);
        wroteAny = true;
        lastChar = value[value.length - 1];
      }
    };
    const startSection = (name) => {
      if (currentSection === name) {
        return;
      }
      if (wroteAny && lastChar !== "\n") {
        writeRaw("\n");
      }
      if (wroteAny) {
        writeRaw("\n");
      }
      writeRaw(`${name}:\n`);
      currentSection = name;
    };
    const emit = (value) => {
      if (typeof value === "string" && value.length > 0) {
        writeRaw(value);
      }
    };
    const pickGeneric = (obj) => {
      if (!obj || typeof obj !== "object") return "";
      if (obj.message && typeof obj.message.content === "string") return obj.message.content;
      if (typeof obj.delta === "string") return obj.delta;
      if (typeof obj.output_text === "string") return obj.output_text;
      if (typeof obj.content === "string") return obj.content;
      if (typeof obj.text === "string") return obj.text;
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
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          if (obj.type === "thinking" && typeof obj.text === "string" && obj.text.length > 0) {
            startSection("Reasoning");
            emit(obj.text);
            return;
          }
          if (obj.type === "assistant" && obj.message && typeof obj.message.content === "string" && obj.message.content.length > 0) {
            startSection("Final answer");
            emit(obj.message.content);
            return;
          }
          if (obj.type === "result" && typeof obj.result === "string" && obj.result.length > 0) {
            startSection("Final answer");
            emit(obj.result);
            return;
          }
        }
        emit(pickGeneric(obj));
      } catch {
        writeRaw(`${line}\n`);
      }
    });
  '
}

jaiph::prompt_impl() {
  local workspace_root
  local backend
  local agent_command
  local trusted_workspace
  local stdin_prompt
  local prompt_text
  local mock_response
  workspace_root="$(jaiph::workspace_root)"
  backend="${JAIPH_AGENT_BACKEND:-cursor}"
  agent_command="${JAIPH_AGENT_COMMAND:-cursor-agent}"
  trusted_workspace="${JAIPH_AGENT_TRUSTED_WORKSPACE:-$workspace_root}"
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
  if jaiph::is_test_mode; then
    if [[ -n "${JAIPH_MOCK_DISPATCH_SCRIPT:-}" ]]; then
      mock_response="$(jaiph::mock_dispatch "$prompt_text")" && {
        printf '%s' "$mock_response"
        return 0
      }
    fi
    if [[ -n "${JAIPH_MOCK_RESPONSES_FILE:-}" ]]; then
      mock_response="$(jaiph::read_next_mock_response)" && {
        printf '%s' "$mock_response"
        return 0
      }
    fi
    # No mock set or mock did not match: run selected backend (cursor or claude) normally.
  fi
  if [[ -n "$prompt_text" ]]; then
    printf "Prompt:\n%s\n\n" "$prompt_text"
  fi
  if [[ "$backend" == "claude" ]]; then
    if ! command -v claude >/dev/null 2>&1; then
      echo "jai: agent.backend is \"claude\" but the Claude CLI (claude) was not found in PATH. Install the Anthropic Claude CLI or set agent.backend = \"cursor\" (or JAIPH_AGENT_BACKEND=cursor)." >&2
      return 1
    fi
    printf '%s' "$prompt_text" | claude 2>&1 | jaiph::stream_json_to_text
    return $?
  fi
  if [[ -n "${JAIPH_AGENT_MODEL:-}" ]]; then
    "$agent_command" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --model "$JAIPH_AGENT_MODEL" --trust "$trusted_workspace" "$prompt_text" \
      | jaiph::stream_json_to_text
    return $?
  fi
  "$agent_command" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --trust "$trusted_workspace" "$prompt_text" \
    | jaiph::stream_json_to_text
}

jaiph::prompt() {
  jaiph::run_step jaiph::prompt jaiph::prompt_impl "$@"
}
