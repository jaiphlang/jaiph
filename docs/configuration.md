---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Configuration

When you need the same workflow sources to behave differently on different machines, you separate **what the graph does** (rules, `prompt` / `script` / `run`, channels) from **operational knobs**: which LLM backend to use, where to write run logs, how inbox dispatch behaves, and how the CLI chooses host vs. Docker. Jaiph keeps the language stable and pushes those choices into **configuration** — in-file `config` blocks, environment variables, and defaults in the tool.

All execution is interpreted by the Node workflow runtime (`NodeWorkflowRuntime`): the AST, managed scripts, prompts, channels, inbox, and `.jaiph/runs` artifacts (see [Architecture](architecture.md)). Configuration only adjusts that stack; it does not change the workflow language or the compile graph.

`jaiph compile` and `buildScripts()` use the same parser, so **unknown `config` keys and wrong value types** fail with deterministic parse errors. Runtime graph loading is parse-only; **compile-time** validation of references runs in the transpile path, not in `buildRuntimeGraph()` (see [Architecture — Summary](architecture.md#summary)).

**Source of truth:** When this document and the implementation disagree, treat the source code as authoritative.

## Three ways to configure

Jaiph provides three configuration mechanisms. When the same key is set in more than one place, the highest-priority source wins:

1. **Environment variables** — highest priority. Includes `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`, `JAIPH_DOCKER_ENABLED`, other `JAIPH_DOCKER_*`, and `JAIPH_UNSAFE` (for Docker on/off, see [Sandboxing — Enabling Docker](sandboxing.md#enabling-docker)). Docker **enablement** is only controlled here — there is no `runtime.*` in-file key for that (removed; using it is a parse error with a migration message).
2. **In-file `config { ... }` blocks** — at module scope and optionally inside a `workflow` body.
3. **Built-in defaults** — lowest priority, used when nothing else sets a value.

For **agent and run keys**, the full precedence chain is:

> **environment > workflow-level config > module-level config > defaults**

For **`runtime.*` (image, network, timeout)**, the CLI merges at **`jaiph run` launch** — not inside `NodeWorkflowRuntime` — in the order **`JAIPH_DOCKER_*` environment > in-file `runtime.*` > defaults** (and separately: Docker on/off is env-only, see above and [Precedence in detail](#precedence-in-detail)). `runtime.*` cannot appear in workflow-level `config` blocks.

## In-file config blocks

### Module-level config

Each `*.jh` file may have **at most one** module-level `config { ... }` block. It is optional. Settings apply to all workflows in **that** file, unless a workflow has its own block.

**`jaiph run`:** the CLI reads **only the entry file’s** module `config` when it builds the initial process environment via `resolveRuntimeEnv` (before spawning the workflow runner or Docker). Imported modules’ module-level `config` is not merged into that first env snapshot — but the runtime still applies per-module and workflow `config` from the [import graph](architecture.md#summary) when you enter a workflow, run a nested `run` in the same module, or `ensure` a rule (see [Scoping across nested calls](#scoping-across-nested-calls)). **Cross-module** `run` and **same-module** `ensure` are special cases, explained there.

```jh
config {
  agent.default_model = "gpt-4"
  agent.backend = "claude"
  agent.claude_flags = "--model sonnet-4"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}

script noop = `true`

rule some_rule() {
  run noop()
}

workflow default() {
  ensure some_rule()
}
```

**Syntax rules:**

- The opening line is `config` and `{` with only optional whitespace between them (and nothing else on that line before `{`).
- One module-level config block per file. A duplicate causes `E_PARSE`: `duplicate config block (only one allowed per file)`.
- May appear at any position among top-level constructs; convention is near the top.
- Unknown keys cause `E_PARSE` and list the allowed keys. Wrong value types also cause `E_PARSE`.

### Workflow-level config

A `config { ... }` block inside a `workflow { ... }` body overrides module-level **agent** and **run** keys for that workflow only. This is useful when different workflows in the same file need different models or backends.

```jh
config {
  agent.backend = "cursor"
  agent.default_model = "gpt-3.5"
}

script noop = `true`

rule some_rule() {
  run noop()
}

workflow fast_check() {
  config {
    agent.backend = "claude"
    agent.default_model = "gpt-4"
  }
  ensure some_rule()
}

workflow default() {
  # Uses module-level config (cursor / gpt-3.5).
  ensure some_rule()
}
```

**Rules:**

- At most one per workflow; it must be the first non-comment construct in the body. A duplicate is `E_PARSE`: `duplicate config block inside workflow (only one allowed per workflow)`.
- Only **`agent.*` and `run.*` keys** are allowed. Any `runtime.*` or `module.*` key is `E_PARSE`.
- Workflow-level values apply to all steps in that workflow, including `ensure`d rules and scripts called from it. When the workflow finishes, the previous environment is restored.

**Sibling isolation:** Each workflow gets its own clone of the parent environment. Sibling workflows never see each other's config — even when they execute sequentially. If workflow `alpha` sets `agent.backend = "claude"` and workflow `beta` only sets `agent.default_model = "beta-model"`, `beta` still sees the module-level backend (e.g. `"cursor"`), not `alpha`'s.

### Value syntax

| Type | Format | Example |
|------|--------|---------|
| String | Double-quoted | `"gpt-4"` |
| Boolean | Unquoted `true` / `false` | `true` |
| Integer | Unsigned decimal digits only | `300` |
Recognized escapes inside strings: `\\`, `\n`, `\t`, `\"`.

## Config keys reference

### Agent keys

These control how `prompt` steps reach the LLM.

| Key | Type | Default | Env variable | Description |
|-----|------|---------|--------------|-------------|
| `agent.default_model` | string | _(unset)_ | `JAIPH_AGENT_MODEL` | Default model for `prompt` steps. |
| `agent.command` | string | `cursor-agent` | `JAIPH_AGENT_COMMAND` | Command line for the cursor backend. First token is the executable; the rest are leading arguments. When the command is not `cursor-agent`, Jaiph treats it as a [custom agent command](#custom-agent-commands) — prompt text is piped via stdin and raw stdout is captured. |
| `agent.backend` | string | `cursor` | `JAIPH_AGENT_BACKEND` | `"cursor"`, `"claude"`, or `"codex"`. See [Backend selection](#backend-selection). |
| `agent.trusted_workspace` | string | workspace root | `JAIPH_AGENT_TRUSTED_WORKSPACE` | Directory passed to Cursor (`--trust`). Relative paths are resolved against the workspace root at CLI launch. |
| `agent.cursor_flags` | string | _(unset)_ | `JAIPH_AGENT_CURSOR_FLAGS` | Extra flags appended for the cursor backend (split on whitespace). |
| `agent.claude_flags` | string | _(unset)_ | `JAIPH_AGENT_CLAUDE_FLAGS` | Extra flags appended for the claude backend (split on whitespace). |

### Run keys

These control runtime behavior unrelated to the agent.

| Key | Type | Default | Env variable | Description |
|-----|------|---------|--------------|-------------|
| `run.logs_dir` | string | `.jaiph/runs` | `JAIPH_RUNS_DIR` | Step log directory. Relative paths are joined with the workspace root; absolute paths are used as-is. |
| `run.debug` | boolean | `false` | `JAIPH_DEBUG` | Enables debug tracing for the run. |
| `run.inbox_parallel` | boolean | `false` | `JAIPH_INBOX_PARALLEL` | Dispatch inbox route targets concurrently. See [Inbox — Parallel dispatch](inbox.md#parallel-dispatch). |
| `run.recover_limit` | integer | `10` | _(no env override)_ | Maximum number of retry attempts for `run … recover` loops before the step fails. See [Language — `recover`](language.md#recover--repair-and-retry-loop). |

### Module keys

Optional descriptive metadata about the workflow module. These are informational only — they do not affect agent, run, or runtime behavior. Future features (e.g. MCP tool metadata) may consume them.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `module.name` | string | _(unset)_ | Human-readable name for this module. |
| `module.version` | string | _(unset)_ | Version string (no validation — any quoted string is accepted). |
| `module.description` | string | _(unset)_ | Short description of what this module does. |

Module keys can only appear in **module-level** config blocks. Any `module.*` key inside a workflow-level config is `E_PARSE`.

```jh
config {
  module.name = "deploy-pipeline"
  module.version = "2.0.0"
  module.description = "Production deployment with rollback"
  agent.backend = "claude"
}

workflow default() {
  log "deploying..."
}
```

### Runtime keys (Docker sandbox — beta)

These configure Docker sandboxing. Unlike agent and run keys, runtime keys are resolved by the `jaiph run` CLI at launch — not by the workflow runtime. They can only appear in **module-level** config blocks (not workflow-level).

> Docker sandboxing is in **beta**. See [Sandboxing](sandboxing.md) for mounts, workspace layout, env forwarding, path remapping, and container behavior.

| Key | Type | Default | Env variable | Description |
|-----|------|---------|--------------|-------------|
| `runtime.docker_image` | string | `ghcr.io/jaiphlang/jaiph-runtime:<version>` | `JAIPH_DOCKER_IMAGE` | Image name. Must already contain `jaiph`. When unset, uses the official GHCR image tag matching the installed jaiph version. For a custom image, build and push (or tag locally), then set this key or `JAIPH_DOCKER_IMAGE`. |
| `runtime.docker_network` | string | `default` | `JAIPH_DOCKER_NETWORK` | Docker network mode. |
| `runtime.docker_timeout_seconds` | integer | `300` | `JAIPH_DOCKER_TIMEOUT` | Timeout in seconds. Use `0` to disable. An invalid or negative **environment** value aborts the run with `E_DOCKER_TIMEOUT` (no silent fallback). In-file must be a non-negative integer. |

## Precedence in detail

### Resolution order

For **agent and run keys**, resolution order (highest wins):

1. **Environment** — `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`. When set, these lock the value for the entire process (see [Locked variables](#locked-variables)).
2. **Workflow-level `config`** — overrides module values for the duration of that workflow.
3. **Module-level `config`** — applies to workflows that don't define their own block.
4. **Built-in defaults.**

For **Docker enablement**, the `jaiph run` driver uses **`JAIPH_DOCKER_ENABLED` env > unsafe default rule** (env only; `runtime.docker_enabled` is no longer supported). The default rule enables Docker unless `JAIPH_UNSAFE=true` is set; `CI=true` no longer disables Docker (see [Sandboxing — Enabling Docker](sandboxing.md#enabling-docker)). For other `runtime.*` keys (image, network, timeout), the merge is **`JAIPH_DOCKER_*` env > module-level `runtime.*` > defaults**. Workflow-level config cannot set runtime keys.

### Locked variables

When `jaiph run` builds the runner environment, any of these environment variables already present in `process.env` gets a matching `${NAME}_LOCKED` flag set to `"1"`:

`JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`

Locked values cannot be overridden by module-level or workflow-level config — they are authoritative for the entire process. This is how environment variables always win in the precedence chain.

### Scoping across nested calls

When workflows call into other workflows, the config scope depends on the call type:

| Call type | What happens |
|-----------|-------------|
| **Root entry** (`jaiph run file.jh`) | Full module + workflow metadata is applied (normal precedence). |
| **Same-module `run`** | Callee's workflow-level `config` is layered on top of the caller's effective env. Module-level config is not re-applied. |
| **Cross-module `run`** (e.g. `run alias.default`) | Caller's effective env carries as-is. Callee's module and workflow config are ignored. The caller's scope wins. |

After any nested call returns, the caller's scope is restored exactly as before.

### `ensure` and cross-module rules

When you `ensure` a rule from **another** module, the runtime merges that module's module-level `config` (`agent.*` / `run.*`) on top of the current environment (respecting locks). Workflow-level config does not apply to rules.

**Same-module** `ensure` keeps the caller's environment as-is, so workflow-level overrides stay in place.

## Backend selection

`prompt` steps use one of three backends:

- **cursor** (default) — runs `agent.command` (default `cursor-agent`) with stream-json output.
- **claude** — runs `claude` on `PATH`. If the executable is missing, Jaiph reports an error and exits.
- **codex** — calls the OpenAI Chat Completions API directly via HTTP. Requires `OPENAI_API_KEY` in the environment. If the key is missing, Jaiph reports an actionable error and exits.

Backend-specific flags come from `agent.cursor_flags` / `agent.claude_flags` (or the matching env vars). The codex backend has no CLI flags; configure it with `OPENAI_API_KEY` and optionally `JAIPH_CODEX_API_URL` (defaults to `https://api.openai.com/v1/chat/completions`). There is no per-`prompt` backend override; the effective backend is whatever the config stack resolves to when the step runs.

### Custom agent commands

When `agent.command` points to an executable other than `cursor-agent`, Jaiph treats it as a **custom agent command**. This lets you use any shell script, Python wrapper, or CLI tool as a prompt backend — no need to implement the `stream-json` protocol.

**How it works:**

1. Jaiph pipes the prompt text to the command's **stdin**.
2. The command's **stdout** is captured as the prompt response (raw text, no JSON framing).
3. **stderr** passes through to the terminal.
4. No cursor-specific flags (`--output-format`, `--stream-partial-output`, `--workspace`, etc.) are appended.

**Display:** The run tree shows the command's basename as the step name — e.g., `prompt echo-wc.sh "..."` instead of `prompt cursor "..."`.

```jh
config {
  agent.command = "./agents/my-agent.sh"
}

workflow default() {
  answer = prompt "Summarize this codebase"
  log "${answer}"
}
```

The custom agent script just reads stdin and prints its answer:

```bash
#!/usr/bin/env bash
input=$(cat)
# ... process the input ...
echo "Here is my summary: ..."
```

Custom commands still participate in the normal prompt lifecycle — `PROMPT_START` / `PROMPT_END` events are emitted, artifacts are written, and `returns` schema validation applies to the captured output.

### Codex setup

```jh
config {
  agent.backend = "codex"
  agent.default_model = "gpt-4o"
}

workflow default() {
  prompt "Explain this codebase"
}
```

Set the API key in your environment:

```bash
export OPENAI_API_KEY="sk-..."
jaiph run main.jh
```

The codex backend streams responses from the OpenAI API and supports structured `returns` schemas like the other backends. The default model is `gpt-4o` when `agent.default_model` is not set. To use a custom-compatible endpoint, set `JAIPH_CODEX_API_URL`.

### Model resolution

When a `prompt` step runs, Jaiph resolves the effective model using this order:

1. **Explicit model** — `agent.default_model` / `JAIPH_AGENT_MODEL` is set and non-empty → use it.
2. **Flags model** — for **cursor** and **claude**, `--model <name>` is found inside the corresponding flags (`agent.cursor_flags` or `agent.claude_flags`) → use it. **Codex** has no flag channel for the model; only step 1 or 3 apply.
3. **Backend default** — **cursor** and **claude** use each CLI’s default when nothing else picks a model. **Codex** defaults to `gpt-4o` in code when no explicit model is set (see [Codex setup](#codex-setup)).

`agent.default_model` applies to **cursor**, **claude**, and **codex**. For the **Claude** backend, when `agent.default_model` is set and `agent.claude_flags` does not already contain `--model`, Jaiph passes `--model <value>` to the Claude CLI automatically. If both are set, the value in `agent.claude_flags` takes precedence (it is appended last).

**Diagnostics.** Every prompt step records the resolved model in `PROMPT_START` and `PROMPT_END` events in `run_summary.jsonl`:

```jsonl
{"type":"PROMPT_START","backend":"cursor","model":"gpt-4","model_reason":"explicit",...}
```

The `model_reason` field is one of: `explicit` (from `agent.default_model`), `flags` (extracted from backend flags), or `backend-default` (no model configured — the backend picks its own). Inspect these events directly in the run summary file.

**No-model troubleshooting.** If the backend rejects the auto-selected default, set `agent.default_model` explicitly or pass `--model <name>` in the backend-specific flags.

## Testing with `jaiph test`

`jaiph test` never calls `resolveRuntimeEnv`. For a `test_run_workflow` step, the test runner builds a child `env` by **spreading `process.env`**, then sets `JAIPH_TEST_MODE`, `JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR` (an ephemeral test path), `JAIPH_SCRIPTS`, and mock fields (`JAIPH_MOCK_RESPONSES_FILE` and/or `JAIPH_MOCK_DISPATCH_SCRIPT`) as needed. There is no CLI pass that pre-merges in-file `config` into that env; **`JAIPH_*_LOCKED` flags are not set** unless you export them in the parent environment yourself.

`NodeWorkflowRuntime` still layers module- and workflow-level in-file `config` with `applyMetadataScope` (same `*_LOCKED` rules: metadata wins only when the key is not locked in the current env). To pin agent settings in CI, set `JAIPH_AGENT_*` / `JAIPH_RUNS_DIR` / `JAIPH_DEBUG` in the environment, and/or keep `config` in the `.jh` module that defines the workflow you exercise. Note: `jaiph run`’s `resolveRuntimeEnv` resolves `agent.trusted_workspace` to an absolute path against the workspace; **metadata-only** merging uses the in-file string as given — for tests, a relative `agent.trusted_workspace` may end up in `JAIPH_AGENT_TRUSTED_WORKSPACE` as-is, so set an absolute path in env or config if you need parity with a normal run.

## Config-to-env mapping

Quick reference for all in-file keys and their environment variable equivalents:

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
| `run.recover_limit` | _(no env override)_ |
| `runtime.docker_image` | `JAIPH_DOCKER_IMAGE` |
| `runtime.docker_network` | `JAIPH_DOCKER_NETWORK` |
| `runtime.docker_timeout_seconds` | `JAIPH_DOCKER_TIMEOUT` |
| `module.name` | _(no env override)_ |
| `module.version` | _(no env override)_ |
| `module.description` | _(no env override)_ |

## Inspecting effective config at runtime

Inside workflows, rules, and scripts, agent and run settings are visible as `JAIPH_*` environment variables. In orchestration strings, `${IDENTIFIER}` resolves from workflow variables first, then from the process environment.

```jh
workflow default() {
  log "backend=${JAIPH_AGENT_BACKEND} trusted_workspace=${JAIPH_AGENT_TRUSTED_WORKSPACE}"
}
```

The runtime also sets `JAIPH_ARTIFACTS_DIR` — the absolute path to the writable artifacts directory for the current run (`.jaiph/runs/<run_id>/artifacts/` on the host, `/jaiph/run/artifacts` inside the Docker sandbox). The `jaiphlang/artifacts` library reads this variable; you can also use it directly in scripts. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox).

`JAIPH_DOCKER_*` variables are **not** populated from in-file `runtime.*` inside the workflow runner process. Docker is configured when the CLI spawns the runner (or container). If you need Docker-related variables inside a `script` step, export them yourself or inherit them from the parent shell.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and writes `.jaiph/SKILL.md` from the skill file bundled with your installation (see `JAIPH_SKILL_PATH` in the CLI reference). It does not add a separate config file — use `config { ... }` in your workflow sources.
