# Jaiph configuration

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

This page describes how to configure the Jaiph runtime: which agent runs `prompt` steps, where logs go, and how debugging behaves. Configuration comes from two places, **in-file config** (in the workflow you pass to `jaiph run`) and **environment variables**. Environment wins over in-file; in-file wins over built-in defaults.

## In-file config

In the entry workflow file (the one you pass to `jaiph run`), you can declare runtime options in a single `config` block. The block must start with exactly `config {` on its own line. You can put it at the top of the file (optionally after a shebang or imports). Only one `config` block per file; a second one causes a parse error (`E_PARSE` and file location).

Inside the block, use `key = value` lines. Empty lines and lines starting with `#` are ignored. Values must be quoted strings (double or single quotes) or `true`/`false`. In quoted strings you can use `\\`, `\n`, `\t`, and `\"`.

```jh
config {
  agent.default_model = "gpt-4"
  agent.command = "cursor-agent"
  agent.backend = "cursor"
  agent.trusted_workspace = ".jaiph/.."
  agent.cursor_flags = "--force"
  agent.claude_flags = "--model sonnet-4"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}

rule some_rule {
  true
}

workflow default {
  ensure some_rule
}
```

Allowed config keys:

- `agent.default_model`: Default model for `prompt` steps (string).
- `agent.command`: Command string for the **cursor** backend (string, e.g. `cursor-agent` or `cursor-agent --force`).
- `agent.backend`: Which prompt backend to use: `"cursor"` (default) or `"claude"`. When `"claude"`, the **Claude CLI** (`claude`) is invoked; it must be on PATH. See [Backend selection](#backend-selection) below.
- `agent.trusted_workspace`: Trusted workspace directory passed to the Cursor backend (`--trust`). In-file: relative paths are resolved from the project root. When set via environment, the value is used as-is (no resolution). Defaults to the project root when unset.
- `agent.cursor_flags`: Extra flags appended to Cursor backend invocation (string; split on whitespace).
- `agent.claude_flags`: Extra flags appended to Claude backend invocation (string; split on whitespace).
- `run.logs_dir`: Directory for step logs. Relative paths are relative to the workspace root; absolute paths are used as-is (string).
- `run.debug`: If `true`, enable shell trace for `jaiph run` (boolean).

## Backend selection

`prompt` steps can use either the **cursor** backend (default) or the **Claude CLI** backend.

- **cursor** (default): Runs the executable from `agent.command` (default `cursor-agent`) with stream-json output. Use this when you run workflows with Cursor’s agent.
- **claude**: Runs the Anthropic **Claude CLI** (`claude`). Use this when you want the same workflow to drive Claude from the terminal. The `claude` binary must be installed and on your PATH. If you set `agent.backend = "claude"` and `claude` is not found, Jaiph prints a clear error and exits.
- Backend-specific flags are appended from `agent.cursor_flags` / `agent.claude_flags` (or env vars below).

No prompt-level backend override exists; the backend is fixed per run by file config and environment. In `jaiph test`, prompt mocks override backend execution; when a prompt is not mocked, the selected backend runs normally (including Claude CLI if `agent.backend = "claude"`).

## Defaults and precedence

Built-in defaults:

- `agent.default_model`: unset (only passed when configured)
- `agent.command`: `cursor-agent`
- `agent.backend`: `cursor`
- `agent.trusted_workspace`: project root
- `agent.cursor_flags`: unset
- `agent.claude_flags`: unset
- `run.logs_dir`: `.jaiph/runs`
- `run.debug`: `false`

Resolution order (highest wins):

1. **Environment variables** — `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`. If a variable is set in the environment, it overrides in-file config and is not overridden when you `run` another module’s workflow (that module’s config applies only to variables not already set).
2. **In-file config** — from the entry workflow’s `config { ... }` block (or the current module’s block when running that module’s workflow).
3. **Built-in defaults** — see above.

## Config to env mapping

- `agent.default_model` -> `JAIPH_AGENT_MODEL`
- `agent.command` -> `JAIPH_AGENT_COMMAND`
- `agent.backend` -> `JAIPH_AGENT_BACKEND`
- `agent.trusted_workspace` -> `JAIPH_AGENT_TRUSTED_WORKSPACE`
- `agent.cursor_flags` -> `JAIPH_AGENT_CURSOR_FLAGS`
- `agent.claude_flags` -> `JAIPH_AGENT_CLAUDE_FLAGS`
- `run.logs_dir` -> `JAIPH_RUNS_DIR`
- `run.debug` -> `JAIPH_DEBUG`

## Inspect effective config at runtime

Inside workflows, rules, and functions, resolved config is available as shell environment variables (`JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, etc.). You can log them to debug scoping and overrides:

```jh
workflow default {
  printf 'backend=%s\n' "$JAIPH_AGENT_BACKEND" >> ".jaiph/meta-debug.log"
  printf 'trusted_workspace=%s\n' "$JAIPH_AGENT_TRUSTED_WORKSPACE" >> ".jaiph/meta-debug.log"
}
```

When a workflow calls another module’s workflow via `run alias.default`, the called workflow runs with that module’s config scope (its `config { }` values fill in any variables not already set by the environment). When the call returns, the caller’s environment is restored.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does not create a config file; use in-file config blocks in your workflow files.
