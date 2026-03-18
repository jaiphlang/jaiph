# Runtime: prompt execution (agent invocation, stream parsing, test mocks).
# Sourced by jaiph_stdlib.sh. Depends on steps.sh and test-mode.sh.

jaiph::format_shell_command() {
  local out=""
  local part escaped
  for part in "$@"; do
    escaped="$(printf "%q" "$part")"
    if [[ -z "$out" ]]; then
      out="$escaped"
    else
      out="$out $escaped"
    fi
  done
  printf "%s" "$out"
}

jaiph::stream_json_to_text() {
  node -e '
    const fs = require("node:fs");
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let reasoning = "";
    let final = "";
    let fallback = "";
    let wroteAnySection = false;
    let wroteReasoningHeader = false;
    let wroteFinalHeader = false;
    let sawFinalStreamDelta = false;
    const append = (base, value) => (typeof value === "string" && value.length > 0 ? base + value : base);
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
    const ensureSection = (name) => {
      if (name === "Reasoning") {
        if (!wroteReasoningHeader) {
          if (wroteAnySection) {
            process.stdout.write("\n\n");
          }
          process.stdout.write("Reasoning:\n");
          wroteAnySection = true;
          wroteReasoningHeader = true;
        }
        return;
      }
      if (!wroteFinalHeader) {
        if (wroteAnySection) {
          process.stdout.write("\n\n");
        }
        process.stdout.write("Final answer:\n");
        wroteAnySection = true;
        wroteFinalHeader = true;
      }
    };
    const writeReasoningDelta = (text) => {
      if (typeof text !== "string" || text.length === 0) return;
      ensureSection("Reasoning");
      process.stdout.write(text);
    };
    const writeFinalDelta = (text) => {
      if (typeof text !== "string" || text.length === 0) return;
      ensureSection("Final answer");
      process.stdout.write(text);
    };
    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
            const event = obj.event;
            if (
              event.type === "content_block_delta" &&
              event.delta &&
              typeof event.delta === "object"
            ) {
              if (
                event.delta.type === "thinking_delta" &&
                typeof event.delta.thinking === "string" &&
                event.delta.thinking.length > 0
              ) {
                reasoning = append(reasoning, event.delta.thinking);
                writeReasoningDelta(event.delta.thinking);
                return;
              }
              if (
                event.delta.type === "text_delta" &&
                typeof event.delta.text === "string" &&
                event.delta.text.length > 0
              ) {
                sawFinalStreamDelta = true;
                final = append(final, event.delta.text);
                writeFinalDelta(event.delta.text);
                return;
              }
            }
          }
          if (obj.type === "thinking" && typeof obj.text === "string" && obj.text.length > 0) {
            reasoning = append(reasoning, obj.text);
            writeReasoningDelta(obj.text);
            return;
          }
          if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
            let reasoningText = "";
            let finalText = "";
            for (const block of obj.message.content) {
              if (!block || typeof block !== "object") continue;
              if (block.type === "thinking" && typeof block.thinking === "string") {
                reasoningText = append(reasoningText, block.thinking);
                continue;
              }
              if (block.type === "text" && typeof block.text === "string") {
                finalText = append(finalText, block.text);
              }
            }
            if (reasoningText.length > 0) {
              reasoning = append(reasoning, reasoningText);
              writeReasoningDelta(reasoningText);
            }
            if (!sawFinalStreamDelta && finalText.length > 0) {
              final = append(final, finalText);
              writeFinalDelta(finalText);
            }
            if (reasoningText.length > 0 || finalText.length > 0) {
              return;
            }
          }
          if (obj.type === "assistant" && obj.message && typeof obj.message.content === "string" && obj.message.content.length > 0) {
            final = append(final, obj.message.content);
            writeFinalDelta(obj.message.content);
            return;
          }
          if (obj.type === "result" && typeof obj.result === "string" && obj.result.length > 0) {
            if (!sawFinalStreamDelta) {
              final = append(final, obj.result);
              writeFinalDelta(obj.result);
            }
            return;
          }
        }
        const generic = pickGeneric(obj);
        final = append(final, generic);
        writeFinalDelta(generic);
      } catch {
        const rawLine = `${line}\n`;
        fallback = append(fallback, rawLine);
        writeFinalDelta(rawLine);
      }
    });
    rl.on("close", () => {
      const effectiveFinal = final.length > 0 ? final : fallback;
      const finalPath = process.env.JAIPH_PROMPT_FINAL_FILE;
      if (typeof finalPath === "string" && finalPath.length > 0) {
        try {
          fs.writeFileSync(finalPath, effectiveFinal, "utf8");
        } catch {
          // Best-effort final capture; prompt logs should still be emitted.
        }
      }
      if (!wroteAnySection && effectiveFinal.length > 0) {
        process.stdout.write(`Final answer:\n${effectiveFinal}`);
      }
    });
  '
}

# Backend abstraction: run the selected prompt backend (cursor or claude).
# Uses caller's workspace_root, agent_command_parts, cursor_extra_flags, claude_extra_flags,
# trusted_workspace, prompt_text. Streams output through jaiph::stream_json_to_text for
# consistent stdout/stderr and JAIPH_PROMPT_FINAL_FILE capture.
jaiph::run_prompt_backend() {
  local backend="$1"
  if [[ "$backend" == "claude" ]]; then
    if ! command -v claude >/dev/null 2>&1; then
      echo "jaiph: agent.backend is \"claude\" but the Claude CLI (claude) was not found in PATH. Install the Anthropic Claude CLI or set agent.backend = \"cursor\" (or JAIPH_AGENT_BACKEND=cursor)." >&2
      return 1
    fi
    printf '%s' "$prompt_text" | claude -p --verbose --output-format stream-json --include-partial-messages "${claude_extra_flags[@]}" 2>&1 | jaiph::stream_json_to_text
    return $?
  fi
  # cursor backend
  if [[ -n "${JAIPH_AGENT_MODEL:-}" ]]; then
    "${agent_command_parts[@]}" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --model "$JAIPH_AGENT_MODEL" --trust "$trusted_workspace" "${cursor_extra_flags[@]}" "$prompt_text" \
      | jaiph::stream_json_to_text
    return $?
  fi
  "${agent_command_parts[@]}" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --trust "$trusted_workspace" "${cursor_extra_flags[@]}" "$prompt_text" \
    | jaiph::stream_json_to_text
}

jaiph::prompt_impl() {
  local workspace_root
  local backend
  local agent_command
  local trusted_workspace
  local stdin_prompt
  local prompt_text
  local mock_response
  local -a agent_command_parts
  local -a cursor_extra_flags
  local -a claude_extra_flags
  local command_for_log
  workspace_root="$(jaiph::workspace_root)"
  backend="${JAIPH_AGENT_BACKEND:-cursor}"
  agent_command="${JAIPH_AGENT_COMMAND:-cursor-agent}"
  # JAIPH_AGENT_COMMAND may contain executable + args (e.g. "cursor-agent --force").
  if ! eval "set -- ${agent_command}"; then
    echo "jaiph: failed to parse agent.command: ${agent_command}" >&2
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    echo "jaiph: agent.command resolved to empty command" >&2
    return 1
  fi
  agent_command_parts=("$@")

  trusted_workspace="${JAIPH_AGENT_TRUSTED_WORKSPACE:-$workspace_root}"
  cursor_extra_flags=()
  claude_extra_flags=()
  if [[ -n "${JAIPH_AGENT_CURSOR_FLAGS:-}" ]]; then
    # Flags are split on shell whitespace; quoted substrings are not preserved.
    read -r -a cursor_extra_flags <<<"${JAIPH_AGENT_CURSOR_FLAGS}"
  fi
  if [[ -n "${JAIPH_AGENT_CLAUDE_FLAGS:-}" ]]; then
    # Flags are split on shell whitespace; quoted substrings are not preserved.
    read -r -a claude_extra_flags <<<"${JAIPH_AGENT_CLAUDE_FLAGS}"
  fi
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
      mock_response="$(jaiph::mock_dispatch "$prompt_text")"
      mock_dispatch_status=$?
      if [[ $mock_dispatch_status -eq 0 ]]; then
        if [[ -n "${JAIPH_PROMPT_FINAL_FILE:-}" ]]; then
          printf '%s' "$mock_response" >"$JAIPH_PROMPT_FINAL_FILE"
        fi
        printf '%s' "$mock_response"
        return 0
      fi
      return "$mock_dispatch_status"
    fi
    if [[ -n "${JAIPH_MOCK_RESPONSES_FILE:-}" ]]; then
      mock_response="$(jaiph::read_next_mock_response)" && {
        if [[ -n "${JAIPH_PROMPT_FINAL_FILE:-}" ]]; then
          printf '%s' "$mock_response" >"$JAIPH_PROMPT_FINAL_FILE"
        fi
        printf '%s' "$mock_response"
        return 0
      }
    fi
    # No mock set or mock did not match: run selected backend (cursor or claude) normally.
  fi
  if [[ -n "$prompt_text" ]]; then
    if [[ "$backend" == "claude" ]]; then
      command_for_log="$(printf "printf %%s %q \\| %s" "$prompt_text" "$(jaiph::format_shell_command claude -p --verbose --output-format stream-json --include-partial-messages "${claude_extra_flags[@]}")")"
    elif [[ -n "${JAIPH_AGENT_MODEL:-}" ]]; then
      command_for_log="$(jaiph::format_shell_command "${agent_command_parts[@]}" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --model "$JAIPH_AGENT_MODEL" --trust "$trusted_workspace" "${cursor_extra_flags[@]}" "$prompt_text")"
    else
      command_for_log="$(jaiph::format_shell_command "${agent_command_parts[@]}" --print --output-format stream-json --stream-partial-output --workspace "$workspace_root" --trust "$trusted_workspace" "${cursor_extra_flags[@]}" "$prompt_text")"
    fi
    printf "Command:\n%s\n\n" "$command_for_log"
    printf "Prompt:\n%s\n\n" "$prompt_text"
  fi
  jaiph::run_prompt_backend "$backend"
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
  eval_line="$(printf '%s' "$raw" | node -e "
    const fs = require('fs');
    const raw = fs.readFileSync(0, 'utf8');
    const schema = JSON.parse(process.env.JAIPH_PROMPT_SCHEMA);
    const captureName = process.env.JAIPH_PROMPT_CAPTURE_NAME || 'result';
    const fields = (schema.fields || []).map(f => ({ name: f.name, type: f.type }));
    const lines = raw.split(/\\n/).filter(l => l.trim().length > 0);
    const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
    const fence = String.fromCharCode(96).repeat(3);
    const fencedPattern = new RegExp(fence + '(?:json)?\\\\s*([\\\\s\\\\S]*?)' + fence, 'gi');
    const fencedMatches = [...raw.matchAll(fencedPattern)];
    const fencedJson = fencedMatches.length > 0 ? String(fencedMatches[fencedMatches.length - 1][1] || '').trim() : '';
    const objectLine = [...lines].reverse().map((l) => l.trim()).find((l) => l.startsWith('{') && l.endsWith('}')) || '';
    const embeddedJson = (() => {
      for (const line of [...lines].reverse()) {
        const trimmed = line.trim();
        const startIdx = trimmed.indexOf('{');
        if (startIdx > 0) {
          const endIdx = trimmed.lastIndexOf('}');
          if (endIdx > startIdx) {
            return trimmed.slice(startIdx, endIdx + 1);
          }
        }
      }
      return '';
    })();
    const candidates = [lastLine, fencedJson, objectLine, embeddedJson].filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);
    let obj;
    let parsedFrom = '';
    let parseError = null;
    for (const candidate of candidates) {
      try {
        obj = JSON.parse(candidate);
        parsedFrom = candidate;
        parseError = null;
        break;
      } catch (e) {
        parseError = e;
      }
    }
    if (!obj) {
      const message = parseError && parseError.message ? parseError.message : 'unknown parse error';
      process.stderr.write('jaiph: prompt returned invalid JSON (parse error): ' + message + '\\n');
      process.stderr.write('Last line: ' + lastLine.slice(0, 200) + (lastLine.length > 200 ? '...' : '') + '\\n');
      process.exit(1);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      process.stderr.write('jaiph: prompt returned invalid JSON: root must be an object\\n');
      process.exit(1);
    }
    for (const f of fields) {
      if (!(f.name in obj)) {
        process.stderr.write('jaiph: prompt response missing required field: ' + f.name + '\\n');
        process.exit(2);
      }
    }
    for (const f of fields) {
      const v = obj[f.name];
      const t = f.type;
      if (t === 'string' && typeof v !== 'string') {
        process.stderr.write('jaiph: prompt response field \"' + f.name + '\" expected string, got ' + typeof v + '\\n');
        process.exit(3);
      }
      if (t === 'number' && typeof v !== 'number') {
        process.stderr.write('jaiph: prompt response field \"' + f.name + '\" expected number, got ' + typeof v + '\\n');
        process.exit(3);
      }
      if (t === 'boolean' && typeof v !== 'boolean') {
        process.stderr.write('jaiph: prompt response field \"' + f.name + '\" expected boolean, got ' + typeof v + '\\n');
        process.exit(3);
      }
    }
    const esc = (s) => String(s).replace(/'/g, \"'\\\\''\");
    let out = captureName + \"='\" + esc(parsedFrom) + \"'\";
    for (const f of fields) {
      const v = obj[f.name];
      out += \"; export \" + captureName + \"_\" + f.name + \"='\" + esc(String(v)) + \"'\";
    }
    process.stdout.write(out);
  " JAIPH_PROMPT_SCHEMA="$schema" JAIPH_PROMPT_CAPTURE_NAME="$capture_name")"
  local node_status=$?
  if [[ "$node_status" -ne 0 ]]; then
    return "$node_status"
  fi
  eval "$eval_line"
}
