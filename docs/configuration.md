---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Jaiph Configuration

Configuration controls how the Jaiph runtime behaves: which agent runs `prompt` steps, where step logs are stored, and whether shell trace (debug) is enabled. There are two sources of configuration:

1. **In-file config** — a `config { ... }` block in the workflow file you pass to `jaiph run`.
2. **Environment variables** — `JAIPH_AGENT_*` and `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`.

Environment overrides in-file; in-file overrides built-in defaults. So: env wins, then in-file, then defaults.

## In-file config

In the entry workflow file (the one you pass to `jaiph run`), you can declare runtime options in a single **config block**. The block is optional. If present, it must start with exactly `config {` on its own line. You can place it at top level anywhere before any rule, function, or workflow (e.g. after a shebang or imports). Only one config block per file; a second one causes a parse error (`E_PARSE` with file location). An unknown config key also yields `E_PARSE`; the error message lists the allowed keys.

Inside the block, use `key = value` lines. Empty lines and lines starting with `#` are ignored. Values must be quoted strings (double or single quotes) or `true` / `false`. In quoted strings you can use `\\`, `\n`, `\t`, and `\"` (backslash, newline, tab, double quote).

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
- `agent.trusted_workspace`: Trusted workspace directory passed to the Cursor backend (`--trust`). When set in-file, relative paths are resolved from the workspace (project) root. When set via environment, the value is used as-is. Defaults to the project root when unset.
- `agent.cursor_flags`: Extra flags appended to Cursor backend invocation (string; split on whitespace).
- `agent.claude_flags`: Extra flags appended to Claude backend invocation (string; split on whitespace).
- `run.logs_dir`: Directory for step logs. Relative paths are resolved against the workspace root at runtime; absolute paths are used as-is (string).
- `run.debug`: If `true`, enables Bash `set -x` (shell trace) for the run (boolean).

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

1. **Environment variables** — `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`. If a variable is set in the environment, it overrides in-file config and is not overridden when you invoke another module’s workflow via `run` (that module’s config only fills in variables that are not already set).
2. **In-file config** — from the entry workflow’s `config { ... }` block, or from the current module’s block when execution is inside that module’s workflow (e.g. after `run other.default`).
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

Inside workflows, rules, and functions, the resolved config is available as shell environment variables (`JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, etc.). You can log them to debug scoping and overrides:

```jh
workflow default {
  printf 'backend=%s\n' "$JAIPH_AGENT_BACKEND" >> ".jaiph/meta-debug.log"
  printf 'trusted_workspace=%s\n' "$JAIPH_AGENT_TRUSTED_WORKSPACE" >> ".jaiph/meta-debug.log"
}
```

When a workflow calls another module’s workflow via `run alias.default`, the called workflow runs with that module’s config scope: its `config { }` values fill in any variables not already set by the environment. When the call returns, the caller’s environment is restored.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does not create a config file; use in-file config blocks in your workflow files.
