# Jaiph configuration

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Runtime behavior is configured via **in-file metadata** and **environment variables**. Config files (TOML) are not used.

## In-file metadata

In the entry workflow file (the one you pass to `jaiph run`), you can declare runtime options at the top:

```jh
metadata {
  agent.default_model = "gpt-4"
  agent.command = "cursor-agent"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}

workflow default {
  ensure some_rule
}
```

Allowed keys:

- `agent.default_model`: Default model for `prompt` steps (string).
- `agent.command`: Agent executable (string, e.g. `cursor-agent`).
- `run.logs_dir`: Directory for step logs, relative to workspace or absolute (string).
- `run.debug`: If `true`, enable shell trace for `jaiph run` (boolean).

Values must be quoted strings or `true`/`false`. Only one `metadata` block per file; parse errors report `E_PARSE` and the file location.

## Precedence

At runtime, Jaiph resolves values in this order (highest wins):

1. Environment variables (`JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`)
2. In-file metadata (from the entry workflow’s `metadata { ... }` block)
3. Built-in defaults

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does not create a config file; use in-file metadata in your workflow files.
