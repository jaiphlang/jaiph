# Jaiph configuration

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Jaiph supports two ways to configure runtime behavior:

1. **In-file metadata** (recommended): a top-level `metadata { ... }` block in your `.jh` workflow file.
2. **Config files** (deprecated): TOML files in global or local scope. Still supported during migration.

When both are present, **in-file metadata overrides config file** for each key.

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

Running a workflow with no external config and only in-file metadata gives deterministic, portable behavior.

## Config files (deprecated)

Config files are still read for backward compatibility. You will see a deprecation notice when a local config file with keys is present. Prefer in-file metadata for new projects.

1. Global: `${XDG_CONFIG_HOME:-~/.config}/jaiph/config.toml`
2. Local: `.jaiph/config.toml` (workspace root)

When both are present, local values override global values.

### Supported keys (TOML)

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

At runtime, Jaiph resolves values in this order (highest wins):

1. Environment variables (`JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`)
2. In-file metadata (from the entry workflow’s `metadata { ... }` block)
3. Local config (`.jaiph/config.toml`)
4. Global config (`~/.config/jaiph/config.toml`)
5. Built-in defaults

## Migration from config file to in-file metadata

1. Open your entry `.jh` file.
2. Add a `metadata { ... }` block at the top with the keys you use from `.jaiph/config.toml` (see allowed keys above).
3. Remove or empty the relevant sections in `.jaiph/config.toml`.
4. Run `jaiph run` as usual; behavior stays the same, with no deprecation warning once the config file has no relevant keys.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/config.toml` if it does not exist yet. New workflows can rely on in-file metadata instead.
