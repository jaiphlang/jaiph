---
title: Configure backend & model
permalink: /how-to/configure-backend
diataxis: how-to
---

# Configure the agent backend and model

This guide shows how to pick which agent backend your `prompt` steps use (`cursor`, `claude`, or `codex`) and which model to request. You can set both in the workflow file with a `config { … }` block or in the environment. The environment wins over the in-file value when both are set.

For the full key/default/precedence reference, see [Configuration](configuration.md). For credential setup per backend, see [Authenticate agent backends](agent-auth.md).

## Prerequisites

- The agent CLI for the chosen backend is on `PATH` (`cursor-agent` for `cursor`, `claude` for `claude`; `codex` uses HTTP and needs no CLI).
- Credentials are set per [Authenticate agent backends](agent-auth.md).

## 1. Set the backend in the entry file

Add a module-level `config { … }` block at the top of your `.jh` file:

```jh
config {
  agent.backend = "claude"
  agent.model = "sonnet-4"
}

export def main() {
  const answer = prompt "Summarize this codebase"
  log "${answer}"
}
```

The valid backend values are `"cursor"` (the default), `"claude"`, and `"codex"`. The model string is forwarded to the backend, so use a name the backend recognizes (e.g. `gpt-4o` for codex, `sonnet-4` for claude).

Set `agent.backend` (and `agent.command`) only from the entry file. Jaiph ignores these two keys when an imported module sets them in its own `config { … }`, so a third-party module cannot redirect your `prompt` steps to a different binary. See [Import trust boundary](configuration.md#import-trust-boundary).

## 2. Override per-workflow

To use a different backend for one workflow in the same file, add a def-level `config { … }` block (it must be the first non-comment construct in the body):

```jh
def fast_check() {
  config {
    agent.backend = "cursor"
    agent.model = "gpt-3.5"
  }
  run review()
}
```

A def-level block can set `agent.*`, `run.*`, and `trusted_envs` keys. The `module.*` keys are module-only, so a def-level block cannot set them.

## 3. Override from the environment

```bash
export JAIPH_AGENT_BACKEND="claude"
export JAIPH_AGENT_MODEL="sonnet-4"
jaiph run ./flow.jh
```

When set, `JAIPH_AGENT_BACKEND` (and the other mapped agent and run env vars) win over in-file `config` for the lifetime of that run. The CLI marks each inherited agent and run env var as locked (`JAIPH_AGENT_BACKEND_LOCKED=1`, and so on), so an in-file override never silently takes effect. In-file `agent.model` does not set `JAIPH_AGENT_MODEL`. Instead it applies to each `prompt` step on its own, and Jaiph passes it as a per-call `--model` flag. To override the model for every prompt in a run, set `JAIPH_AGENT_MODEL` in the shell.

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
- `flags` — from a `--model` embedded in `agent.cursor_flags` / `agent.claude_flags` (see [Configuration](configuration.md)).
- `backend-default` — no model was requested, so the backend CLI picks its own.
- `none` — a [custom agent command](configuration.md#custom-agent-commands) that has no model concept.

When `model_reason` is `backend-default`, codex still calls the API with `gpt-4o` even though `"model"` is `null` in the summary.

## Related

- [Authenticate agent backends](agent-auth.md) — the credentials each backend needs.
- [Configuration — Precedence](configuration.md#precedence) — env vs module vs workflow layering, lock flags, and nested-call scoping.
- [Configuration](configuration.md) — the full set of config keys, defaults, and env equivalents.
