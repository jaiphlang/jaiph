---
title: Configure backend & model
permalink: /how-to/configure-backend
diataxis: how-to
---

# Configure the agent backend and model

This recipe picks which agent backend `prompt` steps use (`cursor`, `claude`, or `codex`) and which model to ask for. Configuration can live in the workflow file (`config { … }`) or in the environment. Environment wins over in-file when both are set.

For the full key/default/precedence reference, see [Configuration](/configuration) (once the Reference quadrant lands). For credential setup per backend, see [Authenticate agent backends](/how-to/agent-auth).

## Prerequisites

- The agent CLI for the chosen backend is on `PATH` (`cursor-agent` for `cursor`, `claude` for `claude`; `codex` uses HTTP and needs no CLI).
- Credentials are set per [Authenticate agent backends](/how-to/agent-auth).

## 1. Set the backend in the entry file

Add a module-level `config { … }` block at the top of your `.jh` file:

```jh
config {
  agent.backend = "claude"
  agent.default_model = "sonnet-4"
}

workflow default() {
  const answer = prompt "Summarize this codebase"
  log "${answer}"
}
```

The valid backend values are `"cursor"` (the default), `"claude"`, and `"codex"`. The model string is forwarded to the backend — use a name the backend recognizes (e.g. `gpt-4o` for codex, `sonnet-4` for claude).

## 2. Override per-workflow

To use a different backend for one workflow in the same file, add a workflow-level `config { … }` block (it must be the first non-comment construct in the body):

```jh
workflow fast_check() {
  config {
    agent.backend = "cursor"
    agent.default_model = "gpt-3.5"
  }
  ensure some_rule()
}
```

Only `agent.*` and `run.*` keys are allowed at workflow scope. `runtime.*` keys are module-only.

## 3. Override from the environment

```bash
export JAIPH_AGENT_BACKEND="claude"
export JAIPH_AGENT_MODEL="sonnet-4"
jaiph run ./flow.jh
```

When set, the environment value wins over both the workflow-level and module-level `config` blocks. The CLI marks the variable as locked (`JAIPH_AGENT_BACKEND_LOCKED=1`) for the lifetime of that run so in-file overrides never silently take effect.

## 4. (Codex) Override the API URL

The `codex` backend defaults to `https://api.openai.com/v1/chat/completions`. To target an OpenAI-compatible endpoint:

```bash
export JAIPH_CODEX_API_URL="https://api.example.com/v1/chat/completions"
```

## Verification

Each `prompt` step records the resolved backend and model in `run_summary.jsonl`. After the run, grep for the first `PROMPT_START`:

```bash
jq -c 'select(.type=="PROMPT_START")' .jaiph/runs/<date>/<time>-<entry>/run_summary.jsonl | head -1
```

The line includes `"backend":"<backend>"` and (when a model resolved) `"model":"<model>"` along with `model_reason` (`explicit`, `flags`, or `backend-default`).

## Related

- [Authenticate agent backends](/how-to/agent-auth) — the credentials each backend needs.
- [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) — where in-file `config` is merged into the runtime environment.
- [Configuration](/configuration) (Reference) — the full set of config keys, defaults, and env equivalents.
