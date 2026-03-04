# Jaiph configuration

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Runtime behavior is configured via **in-file metadata** and **environment variables**.

## In-file metadata

In the entry workflow file (the one you pass to `jaiph run`), you can declare runtime options at the top:

```jh
metadata {
  agent.default_model = "gpt-4"
  agent.command = "cursor-agent"
  agent.backend = "cursor"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}

workflow default {
  ensure some_rule
}
```

Allowed keys:

- `agent.default_model`: Default model for `prompt` steps (string).
- `agent.command`: Agent executable for the **cursor** backend (string, e.g. `cursor-agent`).
- `agent.backend`: Which prompt backend to use: `"cursor"` (default) or `"claude"`. When `"claude"`, the **Claude CLI** (`claude`) is invoked; it must be on PATH. See [Backend selection](#backend-selection) below.
- `run.logs_dir`: Directory for step logs, relative to workspace or absolute (string).
- `run.debug`: If `true`, enable shell trace for `jaiph run` (boolean).

Values must be quoted strings or `true`/`false`. Only one `metadata` block per file; parse errors report `E_PARSE` and the file location.

## Backend selection

`prompt` steps can use either the **cursor** backend (default) or the **Claude CLI** backend.

- **cursor** (default): Runs the executable from `agent.command` (default `cursor-agent`) with stream-json output. Use this when you run workflows with Cursor’s agent.
- **claude**: Runs the Anthropic **Claude CLI** (`claude`). Use this when you want the same workflow to drive Claude from the terminal. The `claude` binary must be installed and on your PATH. If you set `agent.backend = "claude"` and `claude` is not found, Jaiph prints a clear error and exits.

No prompt-level backend override exists; the backend is fixed per run by file metadata and environment.

## Precedence

At runtime, Jaiph resolves values in this order (highest wins):

1. Environment variables (`JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`)
2. In-file metadata (from the entry workflow’s `metadata { ... }` block)
3. Built-in defaults

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does not create a config file; use in-file metadata in your workflow files.
