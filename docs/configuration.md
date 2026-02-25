# Jaiph configuration

[jaiph.org](https://jaiph.org) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](jaiph-skill.md) · [Install](install)

---

Jaiph reads configuration from TOML files in two scopes:

1. Global: `${XDG_CONFIG_HOME:-~/.config}/jaiph/config.toml`
2. Local: `.jaiph/config.toml` (workspace root)

When both are present, local values override global values.

## Supported keys

```toml
[agent]
default_model = "auto"
command = "cursor-agent"

[run]
debug = false
logs_dir = ".jaiph/runs"
```

- `agent.default_model`: Default model used by `prompt` steps. Passed to the agent as `--model <value>`.
- `agent.command`: Agent executable used by runtime (default: `cursor-agent`).
- `run.debug`: If `true`, enables shell trace (`set -x`) for `jaiph run`.
- `run.logs_dir`: Directory for step logs. Can be relative to workspace (for example `.jaiph/runs`) or absolute.

## Precedence

At runtime, Jaiph resolves values in this order:

1. Environment variables (`JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`)
2. Local config (`.jaiph/config.toml`)
3. Global config (`~/.config/jaiph/config.toml`)
4. Built-in defaults

## Created by `jaiph init`

`jaiph init` creates `.jaiph/config.toml` if it does not exist yet.
