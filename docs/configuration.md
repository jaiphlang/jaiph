---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Jaiph Configuration

## Why configuration exists

Jaiph workflows compile to Bash scripts that run agent prompts, shell commands, inbox routing, and rule checks. **Configuration** is how you tune the runtime (which agent backend to use, where logs go, whether the Docker sandbox is on, how inbox dispatch behaves) **without** changing the workflow’s control flow.

You typically set options once per project or per workflow, then rely on the same workflow source in different environments.

## What you can configure (overview)

Three mechanisms apply to **agent** and **run** settings (model, backend, logs directory, debug trace, inbox parallelism):

1. **Environment variables** — `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`, and (for Docker) `JAIPH_DOCKER_*`.
2. **In-file config** — a `config { ... }` block at **module** (file) scope in the entry `.jh` file, and optionally a nested `config { ... }` inside a `workflow { ... }` body for overrides limited to that workflow.
3. **Built-in defaults** — used when nothing else sets a value.

**Precedence** for those agent/run settings: **environment → workflow-level config → module-level config → defaults**. Details are in [Defaults and precedence](#defaults-and-precedence).

**Docker / `runtime.*` keys** follow the same *idea* (environment overrides in-file values), but they are chosen in the `jaiph run` driver when the process starts. They are **not** allowed in workflow-level `config` blocks, and in-file `runtime.*` values are **not** copied into `JAIPH_DOCKER_*` inside the Bash script for you. See [Runtime keys](#runtime-keys-docker-sandbox--beta) and [Inspect effective config at runtime](#inspect-effective-config-at-runtime).

## In-file config (module-level)

In the **entry** workflow file (the path you pass to `jaiph run`), you can declare a single **module-level** `config { ... }` block. It is optional. If it is present:

- The opening line must be exactly `config {` (whitespace allowed before `{`).
- Only **one** module-level config block per file; a second one is `E_PARSE` (`duplicate config block`).
- The block may appear at any position among other **top-level** constructs (e.g. before or after `import` lines); convention is near the top, after an optional shebang.
- **Unknown keys** are `E_PARSE`; the error lists allowed keys. **Wrong value types** (e.g. a string for `runtime.docker_timeout`) are also `E_PARSE`. For `agent.backend`, only `"cursor"` and `"claude"` are allowed.

Inside the block, each non-comment line is `key = value`. Empty lines and lines starting with `#` are ignored.

### Value syntax

- **Strings** — double- or single-quoted. Recognized escapes inside the quotes: `\\`, `\n`, `\t`, `\"`.
- **Booleans** — `true` or `false` (unquoted).
- **Integers** — unsigned decimal digits only (e.g. `300`). No floats, negatives, or hex.
- **String arrays** — start with `=` and `[` on the **same** line (after the key), then one quoted string per line, then `]` or `],`. Trailing commas and `#` comments between elements are allowed. `= []` is valid.

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
  runtime.docker_enabled = true
  runtime.docker_timeout = 300
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:config:ro"
  ]
}

rule some_rule {
  true
}

workflow default {
  ensure some_rule
}
```

### Agent keys

- `agent.default_model`: Default model for `prompt` steps (string). Exposed to Bash as `JAIPH_AGENT_MODEL`.
- `agent.command`: Full command line for the **cursor** backend (string), e.g. `cursor-agent` or `cursor-agent --force`. Parsed in Bash for the executable and arguments.
- `agent.backend`: `"cursor"` (default) or `"claude"`. For `"claude"`, the **Claude CLI** (`claude`) must be on `PATH`. See [Backend selection](#backend-selection).
- `agent.trusted_workspace`: Directory passed to the Cursor backend (`--trust`). For **`jaiph run`**, when this comes from **module-level** config and is a relative path, the CLI resolves it to an absolute path under the workspace root before the workflow runs. **Workflow-level** overrides and the defaults emitted into the script use the string as written; at prompt time the runtime uses `"${JAIPH_AGENT_TRUSTED_WORKSPACE:-$workspace_root}"`, so relative values are interpreted relative to the process working directory (the workspace root for normal `jaiph run`). When set via **`JAIPH_AGENT_TRUSTED_WORKSPACE`** in the environment, that value is used as-is (and locks overrides from in-file config for the whole process).
- `agent.cursor_flags` / `agent.claude_flags`: Extra flags appended for the selected backend (string; split on whitespace in Bash).

### Run keys

- `run.logs_dir`: Step log directory (string). Default `.jaiph/runs`. If the effective value is **relative**, the runtime joins it with the workspace root; **absolute** paths are used as-is. Maps to `JAIPH_RUNS_DIR`.
- `run.debug`: If `true`, enables Bash `set -x` for the run (`JAIPH_DEBUG`). Omitted or `false` leaves tracing off unless the environment sets `JAIPH_DEBUG`.
- `run.inbox_parallel`: If `true`, inbox route targets for each batch are dispatched concurrently (default `false`). See [Inbox & Dispatch — Parallel dispatch](inbox.md#parallel-dispatch). Maps to `JAIPH_INBOX_PARALLEL`.

### Runtime keys (Docker sandbox — beta)

> Docker sandboxing is in **beta**. See [Sandboxing](sandboxing.md) for mounts, workspace layout, Dockerfile detection, env forwarding, path remapping, and container behavior.

- `runtime.docker_enabled`: Enable Docker for this run (boolean, default `false`).
- `runtime.docker_image`: Image name (string, default `"ubuntu:24.04"`). When **no** image is set in config or environment, Jaiph may instead build and use an image from `.jaiph/Dockerfile` if that file exists in the workspace root.
- `runtime.docker_network`: Docker network mode (string, default `"default"`).
- `runtime.docker_timeout`: Timeout in seconds (integer, default `300`).
- `runtime.workspace`: Mount list (string array, default `[".:/jaiph/workspace:rw"]`). **Not** overridable via environment variables; only in-file values and defaults apply.

## Workflow-level config

A `config { ... }` block may appear **inside** a `workflow { ... }` body to override module-level **agent** and **run** keys for that workflow only.

Rules:

- At most one such block per workflow; it must be the first content in the body (only comments may appear before it).
- Allowed keys: **`agent.*` and `run.*` only**. Any `runtime.*` key is `E_PARSE` (Docker stays module-level / env).

```jh
config {
  agent.backend = "cursor"
  agent.default_model = "gpt-3.5"
}

workflow fast_check {
  config {
    agent.backend = "claude"
    agent.default_model = "gpt-4"
  }
  ensure some_rule
}

workflow default {
  # Uses module-level config (cursor / gpt-3.5).
  ensure some_rule
}
```

Workflow-level values apply to all steps in that workflow, including `ensure`d rules and scripts called from it. When the workflow finishes, the previous environment is restored. Other workflows in the same file are unaffected.

**Precedence inside a workflow (highest wins):**

1. **Environment** — `JAIPH_*` values present when `jaiph run` starts win and set the corresponding `*_LOCKED` markers so nested `run` into another module cannot replace them.
2. **Workflow-level `config`** — overrides module in-file values for the duration of that workflow; its exports also set `_LOCKED` so inner module-level scopes (rule/script wrappers) do not revert them.
3. **Module-level `config`** — fills in values for workflows without their own block.
4. **Defaults** — see below.

**Nested `run` — metadata scope inheritance:**

When a workflow calls `run` into another workflow, the metadata scope that applies depends on whether the call crosses a module boundary:

| Call type | What happens |
|-----------|-------------|
| **Same-module** `run` (workflow in the same `.jh` file) | Callee’s **workflow-level** `config` is layered on top of the caller’s effective env. Module-level config is **not** re-applied. |
| **Cross-module** `run` (e.g. `run alias.default`) | The caller’s effective env is carried as-is — **neither** the callee’s module-level nor workflow-level config is applied. The callee inherits the caller’s scope wholesale. |
| **Root entry** (`jaiph run file.jh`) | Full module + workflow metadata from the entry file is applied (normal precedence). |

This means a parent workflow’s configuration is authoritative across nested calls. If `parent.jh` sets `agent.backend = "cursor"` and calls `run child.default` where `child.jh` sets `agent.backend = "claude"`, the child still runs with `cursor` — the caller’s scope wins.

After a nested call returns, the caller’s scope is restored exactly as it was before the call.

**Locked variables** (`JAIPH_*_LOCKED`) from CLI environment overrides remain authoritative across all nesting levels — neither module nor workflow config can override a locked value.

## Backend selection

`prompt` steps use either the **cursor** backend (default) or the **Claude CLI**:

- **cursor**: Runs `agent.command` (default `cursor-agent`) with stream-json output.
- **claude**: Runs `claude` on `PATH`. If the backend is `claude` but the executable is missing, Jaiph reports an error and exits.

Backend-specific flags come from `agent.cursor_flags` / `agent.claude_flags` (or the matching env vars). There is no per-`prompt` backend override; the effective backend is whatever the config/env stack resolves to when the step runs. In `jaiph test`, mocked prompts skip real backend execution; unmocked prompts use the resolved backend.

## Defaults and precedence

### Built-in defaults (agent, run, runtime)

- `agent.default_model`: unset (omitted from generated exports until set)
- `agent.command`: `cursor-agent`
- `agent.backend`: `cursor`
- `agent.trusted_workspace`: workspace root (via runtime default when unset)
- `agent.cursor_flags` / `agent.claude_flags`: unset
- `run.logs_dir`: `.jaiph/runs`
- `run.debug`: `false`
- `run.inbox_parallel`: `false`
- `runtime.docker_enabled`: `false`
- `runtime.docker_image`: `"ubuntu:24.04"`
- `runtime.docker_network`: `"default"`
- `runtime.docker_timeout`: `300`
- `runtime.workspace`: `[".:/jaiph/workspace:rw"]`

### Resolution order (agent / run)

1. **Environment** — `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`. When set here, values override in-file config for the **entire** `jaiph run` process and lock against replacement on nested `run` (see [Config to env mapping](#config-to-env-mapping)).
2. **Workflow-level `config`** — for steps inside that workflow; locks its overrides as described above.
3. **Module-level `config`** — from the entry file, or from the current module after `run other.default` establishes that module’s scope.
4. **Built-in defaults** — as listed.

### Docker / `runtime.*` (driver-only)

For `runtime.*`, the `jaiph run` driver merges **`JAIPH_DOCKER_*` environment** → **module-level in-file `runtime.*`** → **defaults** (mounts are **not** taken from env). Workflow-level `config` cannot set these. Invalid or unparsable `JAIPH_DOCKER_TIMEOUT` falls back to the default timeout.

## Config to env mapping

| In-file key | Environment variable |
|-------------|----------------------|
| `agent.default_model` | `JAIPH_AGENT_MODEL` |
| `agent.command` | `JAIPH_AGENT_COMMAND` |
| `agent.backend` | `JAIPH_AGENT_BACKEND` |
| `agent.trusted_workspace` | `JAIPH_AGENT_TRUSTED_WORKSPACE` |
| `agent.cursor_flags` | `JAIPH_AGENT_CURSOR_FLAGS` |
| `agent.claude_flags` | `JAIPH_AGENT_CLAUDE_FLAGS` |
| `run.logs_dir` | `JAIPH_RUNS_DIR` |
| `run.debug` | `JAIPH_DEBUG` |
| `run.inbox_parallel` | `JAIPH_INBOX_PARALLEL` |
| `runtime.docker_enabled` | `JAIPH_DOCKER_ENABLED` |
| `runtime.docker_image` | `JAIPH_DOCKER_IMAGE` |
| `runtime.docker_network` | `JAIPH_DOCKER_NETWORK` |
| `runtime.docker_timeout` | `JAIPH_DOCKER_TIMEOUT` |
| `runtime.workspace` | _(no env override)_ |

## Inspect effective config at runtime

Inside workflows, rules, and scripts, **agent** and **run** settings are visible as the usual `JAIPH_*` variables, for example `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_MODEL`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, and `JAIPH_INBOX_PARALLEL`.

```jh
workflow default {
  printf 'backend=%s\n' "$JAIPH_AGENT_BACKEND" >> ".jaiph/meta-debug.log"
  printf 'trusted_workspace=%s\n' "$JAIPH_AGENT_TRUSTED_WORKSPACE" >> ".jaiph/meta-debug.log"
}
```

`JAIPH_DOCKER_*` is **not** populated from in-file `runtime.*` inside the Bash process. Those variables only affect the run if they are already present in the environment that launches `jaiph run` (or if your script exports them itself).

When a workflow calls another module via `run alias.default`, the callee **inherits the caller’s effective metadata scope** — the callee’s own module `config` is not applied. This ensures the caller’s configuration (e.g. backend, model) remains authoritative across nested calls. When the call returns, the caller’s values are restored. For same-module nested calls, callee workflow-level config is still layered on top of the caller’s env.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does **not** add a separate config file; use `config { ... }` in your workflow sources.
