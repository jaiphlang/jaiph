---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Jaiph Configuration

## Why configuration exists

Jaiph runs workflows through the **Node workflow runtime** (`NodeWorkflowRuntime`): it interprets the AST, executes `prompt` and `script` steps via the JS kernel, and handles channels, inbox dispatch, and artifacts (see [Architecture](../ARCHITECTURE.md)). **Configuration** is how you tune that runtime—which agent backend to use, where logs go, whether the Docker sandbox is on, how inbox dispatch behaves—**without** changing control flow in your `.jh` sources.

You typically set options once per project or per workflow, then reuse the same sources across environments (CLI flags and env vars supply the rest).

## What you can configure (overview)

Three mechanisms apply to **agent** and **run** settings (model, backend, logs directory, debug trace, inbox parallelism):

1. **Environment variables** — `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`, and (for Docker) `JAIPH_DOCKER_*`.
2. **In-file config** — a `config { ... }` block at **module** (file) scope in the entry `.jh` file, and optionally a nested `config { ... }` inside a `workflow { ... }` body for overrides limited to that workflow.
3. **Built-in defaults** — used when nothing else sets a value.

**Precedence** for those agent/run settings: **environment → workflow-level config → module-level config → defaults**. Details are in [Defaults and precedence](#defaults-and-precedence).

**Docker / `runtime.*` keys** follow the same *idea* (environment overrides in-file values), but they are resolved in the **`jaiph run` CLI** when it decides whether to spawn the workflow inside a container. They are **not** allowed in workflow-level `config` blocks. In-file `runtime.*` is **not** merged into the workflow runner’s `process.env` as `JAIPH_DOCKER_*`; those variables only exist if the shell already exported them before `jaiph run` or a step sets them. See [Runtime keys](#runtime-keys-docker-sandbox--beta) and [Inspect effective config at runtime](#inspect-effective-config-at-runtime).

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
- **String arrays** — the line must be `key = [` with `[` on the same line as `=`, then one quoted string per line, then `]` or `],`. Trailing commas and `#` comments between elements are allowed. `key = []` on one line is valid for an empty array.

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
  ensure some_rule()
}
```

### Agent keys

- `agent.default_model`: Default model for `prompt` steps (string). Surfaces as `JAIPH_AGENT_MODEL` in the process environment.
- `agent.command`: Full command line for the **cursor** backend (string), e.g. `cursor-agent` or `cursor-agent --force`. The prompt kernel splits on whitespace: the first token is the executable, the rest are leading arguments before Jaiph adds its own flags.
- `agent.backend`: `"cursor"` (default) or `"claude"`. For `"claude"`, the **Claude CLI** (`claude`) must be on `PATH`. See [Backend selection](#backend-selection).
- `agent.trusted_workspace`: Directory passed to the Cursor backend (`--trust`). When **`jaiph run`** builds the initial runner environment, a relative path from the **entry file’s** module-level `config` is resolved to an absolute path under the workspace root. **Workflow-level** overrides are applied later inside the runtime as the string stored in the AST (not re-resolved the same way). The prompt kernel uses `JAIPH_AGENT_TRUSTED_WORKSPACE` if set, otherwise the workspace root. If **`JAIPH_AGENT_TRUSTED_WORKSPACE`** is already set in the environment when the CLI starts, it wins and is marked locked so in-file config cannot override it for that process.
- `agent.cursor_flags` / `agent.claude_flags`: Extra flags appended for the selected backend (string; split on whitespace in the prompt kernel).

### Run keys

- `run.logs_dir`: Step log directory (string). Default `.jaiph/runs`. If the effective value is **relative**, the runtime joins it with the workspace root; **absolute** paths are used as-is. Maps to `JAIPH_RUNS_DIR`.
- `run.debug`: If `true`, enables debug tracing for the run (`JAIPH_DEBUG`). Omitted or `false` leaves tracing off unless the environment sets `JAIPH_DEBUG`.
- `run.inbox_parallel`: If `true`, inbox route targets for each batch are dispatched concurrently (default `false`). See [Inbox & Dispatch — Parallel dispatch](inbox.md#parallel-dispatch). Maps to `JAIPH_INBOX_PARALLEL`.

### Runtime keys (Docker sandbox — beta)

> Docker sandboxing is in **beta**. See [Sandboxing](sandboxing.md) for mounts, workspace layout, Dockerfile detection, env forwarding, path remapping, and container behavior.

- `runtime.docker_enabled`: Enable Docker for this run (boolean, default `false`).
- `runtime.docker_image`: Image name (string, default `"node:20-bookworm"`). When **neither** in-file config nor `JAIPH_DOCKER_IMAGE` sets an image, Jaiph may build and use an image from `.jaiph/Dockerfile` if that file exists in the workspace root (otherwise it uses the default image and pulls it if needed).
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
  ensure some_rule()
}

workflow default {
  # Uses module-level config (cursor / gpt-3.5).
  ensure some_rule()
}
```

Workflow-level values apply to all steps in that workflow, including `ensure`d rules and scripts called from it. When the workflow finishes, the previous environment is restored.

**Sibling isolation:** Each workflow receives its own clone of the parent environment before its `config` is applied. Sibling workflows in the same `run` never see each other's metadata — even when they execute sequentially under a shared parent. For example, if workflow `alpha` sets `agent.backend = "claude"` and workflow `beta` sets `agent.default_model = "beta-model"` without overriding `backend`, `beta` still sees the module-level backend (e.g. `"cursor"`), not `alpha`'s `"claude"`.

**Precedence inside a workflow (highest wins):**

1. **Environment** — `JAIPH_*` values present when `jaiph run` starts win and set the corresponding `*_LOCKED` markers so in-file metadata cannot replace them for that process.
2. **Workflow-level `config`** — overrides module in-file values for the duration of that workflow’s steps (and nested calls that inherit that scope; see below).
3. **Module-level `config`** — fills in values for workflows that do not define their own workflow-level block (and is combined with workflow-level when entering the entry workflow).
4. **Defaults** — see below.

**Nested `run` — metadata scope inheritance:**

When a workflow calls `run` into another workflow, the metadata scope that applies depends on whether the call crosses a module boundary:

| Call type | What happens |
|-----------|-------------|
| **Same-module** `run` (workflow in the same `.jh` file) | Callee’s **workflow-level** `config` is layered on top of the caller’s effective env. Module-level config is **not** re-applied. Same-module rules also inherit the caller’s effective env directly, so workflow-level overrides are not lost. |
| **Cross-module** `run` (e.g. `run alias.default`) | The caller’s effective env is carried as-is — **neither** the callee’s module-level nor workflow-level config is applied. The callee inherits the caller’s scope wholesale. |
| **Root entry** (`jaiph run file.jh`) | Full module + workflow metadata from the entry file is applied (normal precedence). |

This means a parent workflow’s configuration is authoritative across nested calls. If `parent.jh` sets `agent.backend = "cursor"` and calls `run child.default` where `child.jh` sets `agent.backend = "claude"`, the child still runs with `cursor` — the caller’s scope wins.

After a nested call returns, the caller’s scope is restored exactly as it was before the call.

### `ensure` and cross-module rules

Nested `run` is not the only way execution crosses files. When you `ensure` a rule defined in **another** module, the runtime merges that file’s **module-level** `config` (`agent.*` / `run.*`) on top of the current environment for that rule (respecting `*_LOCKED`). It does **not** apply the callee’s **workflow-level** `config` (rules are not workflows). **Same-module** `ensure` keeps the caller’s environment as-is—the callee’s module-level metadata is not applied again—so the caller workflow’s effective settings (including its workflow-level overrides) stay in place.

**Locked variables** (`JAIPH_*_LOCKED`) are set only when the corresponding `JAIPH_*` variable is already present in the process environment **before** the CLI builds the runner environment. Those flags remain authoritative across nesting—neither module nor workflow metadata overrides a locked value.

## Backend selection

`prompt` steps use either the **cursor** backend (default) or the **Claude CLI**:

- **cursor**: Runs `agent.command` (default `cursor-agent`) with stream-json output.
- **claude**: Runs `claude` on `PATH`. If the backend is `claude` but the executable is missing, Jaiph reports an error and exits.

Backend-specific flags come from `agent.cursor_flags` / `agent.claude_flags` (or the matching env vars). There is no per-`prompt` backend override; the effective backend is whatever the config/env stack resolves to when the step runs. In `jaiph test`, mocked prompts skip real backend execution; unmocked prompts use the resolved backend. The **`jaiph test`** harness does not run the same initial environment merge as **`jaiph run`** (it starts from `process.env` plus test variables such as `JAIPH_TEST_MODE`). For predictable agent settings in tests, set `JAIPH_AGENT_*` in the environment or rely on in-file `config` on the workflow’s module as applied by the runtime when the workflow executes.

## Defaults and precedence

### Built-in defaults (agent, run, runtime)

- `agent.default_model`: unset unless provided by in-file config or environment
- `agent.command`: `cursor-agent`
- `agent.backend`: `cursor`
- `agent.trusted_workspace`: workspace root (via runtime default when unset)
- `agent.cursor_flags` / `agent.claude_flags`: unset
- `run.logs_dir`: `.jaiph/runs`
- `run.debug`: `false`
- `run.inbox_parallel`: `false`
- `runtime.docker_enabled`: `false`
- `runtime.docker_image`: `"node:20-bookworm"`
- `runtime.docker_network`: `"default"`
- `runtime.docker_timeout`: `300`
- `runtime.workspace`: `[".:/jaiph/workspace:rw"]`

### Resolution order (agent / run)

1. **Environment** — `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`. When set here, values override in-file config for the **entire** `jaiph run` process and lock against replacement on nested `run` (see [Config to env mapping](#config-to-env-mapping)).
2. **Workflow-level `config`** — for steps inside that workflow (see the nested-`run` table for how it combines with nested calls).
3. **Module-level `config`** — from the `.jh` file that defines the workflow, combined with that workflow’s workflow-level block when a workflow is entered normally (not cross-module nested `run`). It is **not** re-applied on **same-module** nested `run` (only the callee’s workflow-level `config` is layered; see the table above).
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

`JAIPH_DOCKER_*` is **not** populated from in-file `runtime.*` inside the workflow runner process. Docker is configured when the **CLI** spawns the runner (or container); the mapping table above describes how in-file `runtime.*` relates to `JAIPH_DOCKER_*` at that launch boundary. If you need those variables inside a `script` step, export them yourself or inherit them from the parent shell.

When a workflow calls another module via `run alias.default`, the callee **inherits the caller’s effective metadata scope** — the callee’s module and workflow `config` blocks are ignored for that call. When the call returns, the caller’s environment is restored. Same-module nested `run` still layers the callee’s **workflow-level** `config` on the caller’s env, as in the table above.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does **not** add a separate config file; use `config { ... }` in your workflow sources.
