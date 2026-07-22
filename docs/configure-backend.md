---
title: Configure backend & model
permalink: /how-to/configure-backend
diataxis: how-to
---

# Configure the agent backend and model

This recipe picks which agent backend `prompt` steps use (`cursor`, `claude`, or `codex`) and which model to ask for. Configuration can live in the workflow file (`config { … }`) or in the environment. Environment wins over in-file when both are set.

For the full key/default/precedence reference, see [Configuration](/reference/configuration). For credential setup per backend, see [Authenticate agent backends](/how-to/agent-auth).

## Prerequisites

- The agent CLI for the chosen backend is on `PATH` (`cursor-agent` for `cursor`, `claude` for `claude`; `codex` uses HTTP and needs no CLI).
- Credentials are set per [Authenticate agent backends](/how-to/agent-auth).

## 1. Set the backend in the entry file

Add a module-level `config { … }` block at the top of your `.jh` file:

```jh
config {
  agent.backend = "claude"
  agent.model = "sonnet-4"
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
    agent.model = "gpt-3.5"
  }
  ensure some_rule()
}
```

Only `agent.*` and `run.*` keys are allowed at workflow scope. `runtime.*` and `module.*` keys are module-only.

## 3. Override from the environment

```bash
export JAIPH_AGENT_BACKEND="claude"
export JAIPH_AGENT_MODEL="sonnet-4"
jaiph run ./flow.jh
```

When set, `JAIPH_AGENT_BACKEND` (and other mapped agent/run env vars) win over in-file `config` for the lifetime of that run. The CLI marks inherited agent/run env vars as locked (`JAIPH_AGENT_BACKEND_LOCKED=1`, …) so in-file overrides never silently take effect. Model is different: in-file `agent.model` does not set `JAIPH_AGENT_MODEL` — it applies per `prompt` step only. Set `JAIPH_AGENT_MODEL` in the shell to override the model for every prompt in a run.

## 4. (Codex) Override the API URL

The `codex` backend defaults to `https://api.openai.com/v1/chat/completions`. To target an OpenAI-compatible endpoint:

```bash
export JAIPH_CODEX_API_URL="https://api.example.com/v1/chat/completions"
```

## Verification

Each `prompt` step records the resolved backend and model in `run_summary.jsonl`. After the run, inspect the first `PROMPT_START` line:

```bash
jq -c 'select(.type=="PROMPT_START")' .jaiph/runs/<date>/<time>-<entry>/run_summary.jsonl | head -1
```

The line includes `"backend":"<backend>"`, `"model"` (the resolved string, or `null` when the backend auto-selects), and `model_reason`:

- `explicit` — from `agent.model` or `JAIPH_AGENT_MODEL`.
- `flags` — from a `--model` embedded in `agent.cursor_flags` / `agent.claude_flags` (see [Configuration](/reference/configuration)).
- `backend-default` — no model was requested, so the backend CLI picks its own.

When `model_reason` is `backend-default`, codex still calls the API with `gpt-4o` even though `"model"` is `null` in the summary.

## Related

- [Authenticate agent backends](/how-to/agent-auth) — the credentials each backend needs.
- [Configuration — Precedence](/reference/configuration#precedence) — env vs module vs workflow layering, lock flags, and nested-call scoping.
- [Configuration](/reference/configuration) — the full set of config keys, defaults, and env equivalents.
