---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Configuration

Jaiph separates **what runs** (your `.jh` graphs) from **how the host runs it** (models, paths, sandboxes, logging). Operational settings live in **configuration** so the same `.jh` sources work unchanged across machines and CI.

All execution goes through the Node workflow runtime (`NodeWorkflowRuntime`), which interprets the AST, runs `prompt` and `script` steps, and handles channels, inbox dispatch, and artifacts (see [Architecture](architecture)). Configuration tunes this stack — agent backend, runs directory, inbox parallelism — without touching control flow.

**Source of truth:** When this document and the implementation disagree, treat the source code as authoritative.

## Three ways to configure

Jaiph provides three configuration mechanisms. When the same key is set in more than one place, the highest-priority source wins:

1. **Environment variables** — highest priority. `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`, and `JAIPH_RECOVER_LIMIT`.
2. **In-file `config { ... }` blocks** — at module scope and optionally inside a `workflow` body.
3. **Built-in defaults** — lowest priority, used when nothing else sets a value.

For **agent and run keys**, the full precedence chain is:

> **environment > workflow-level config > module-level config > defaults**

## In-file config blocks

### Module-level config

Place a `config { ... }` block in the **entry** workflow file (the path passed to `jaiph run`). It is optional and applies to every workflow in that file unless a workflow provides its own overrides.

```jh
config {
  agent.default_model = "gpt-4"
  agent.backend = "claude"
  agent.claude_flags = "--model sonnet-4"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}

script noop = `true`

workflow some_check() {
  run noop()
}

workflow default() {
  run readonly some_check()
}
```

**Syntax rules:**

- The opening line must be exactly `config {` (optional whitespace around tokens, nothing else).
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

workflow fast_check() {
  config {
    agent.backend = "claude"
    agent.default_model = "gpt-4"
  }
  run readonly some_check()
}

workflow default() {
  # Uses module-level config (cursor / gpt-3.5).
  run readonly some_check()
}
```

**Rules:**

- At most one per workflow; it must be the first non-comment construct in the body. A duplicate is `E_PARSE`: `duplicate config block inside workflow (only one allowed per workflow)`.
- Only **`agent.*` and `run.*` keys** are allowed. Any `module.*` key is `E_PARSE`.
- Workflow-level values apply to all steps in that workflow, including `run readonly` targets and scripts called from it. When the workflow finishes, the previous environment is restored.

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
| `run.recover_limit` | integer | `10` | `JAIPH_RECOVER_LIMIT` | Maximum number of attempts for `run … recover` retry loops. When exhausted the step fails. See [Grammar — `run … recover`](grammar#run-recover). |

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

### Isolated execution keys (host-level only)

These environment variables configure the Docker backend used by `run isolated` steps. They are host-level tuning knobs — not settable in `.jh` config blocks.

| Env variable | Default | Description |
|---|---|---|
| `JAIPH_ISOLATED_IMAGE` | `ghcr.io/jaiphlang/jaiph-runtime:<version>` | Container image for `run isolated` calls. Must already contain `jaiph`. |
| `JAIPH_DOCKER_NETWORK` | `default` | Docker network mode for isolated containers. |
| `JAIPH_DOCKER_TIMEOUT` | `300` | Timeout in seconds for isolated containers. |

There is no config key or env var that disables isolation — `run isolated` always means OS-level isolation. See [Sandboxing — Per-call isolation](sandboxing.md#per-call-isolation-with-run-isolated).

## Precedence in detail

### Resolution order

For **agent and run keys**, resolution order (highest wins):

1. **Environment** — `JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`. When set, these lock the value for the entire process (see [Locked variables](#locked-variables)).
2. **Workflow-level `config`** — overrides module values for the duration of that workflow.
3. **Module-level `config`** — applies to workflows that don't define their own block.
4. **Built-in defaults.**

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

### `run readonly` and cross-module calls

When you `run readonly` a workflow from **another** module, the runtime merges that module's module-level `config` (`agent.*` / `run.*`) on top of the current environment (respecting locks).

**Same-module** `run readonly` keeps the caller's environment as-is, so workflow-level overrides stay in place.

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
2. **Flags model** — `--model <name>` is found inside the backend-specific flags (`agent.cursor_flags` or `agent.claude_flags`) → use it.
3. **Backend default** — no model specified anywhere → the backend CLI auto-selects its own default model.

`agent.default_model` works for **both** backends. For the Claude backend, when `agent.default_model` is set and `agent.claude_flags` does not already contain `--model`, Jaiph passes `--model <value>` to the Claude CLI automatically. If both are set, the value in `agent.claude_flags` takes precedence (it is appended last).

**Diagnostics.** Every prompt step records the resolved model in `PROMPT_START` and `PROMPT_END` events in `run_summary.jsonl`:

```jsonl
{"type":"PROMPT_START","backend":"cursor","model":"gpt-4","model_reason":"explicit",...}
```

The `model_reason` field is one of: `explicit` (from `agent.default_model`), `flags` (extracted from backend flags), or `backend-default` (no model configured — the backend picks its own). Inspect these events directly in the run summary file.

**No-model troubleshooting.** If the backend rejects the auto-selected default, set `agent.default_model` explicitly or pass `--model <name>` in the backend-specific flags.

## Testing with `jaiph test`

The test harness does **not** call `resolveRuntimeEnv` — it constructs a minimal env (`process.env` plus `JAIPH_TEST_MODE`, `JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, `JAIPH_SCRIPTS`, and mock variables). CLI-side defaults and lock flags are not available in tests.

When a `test_run_workflow` step runs, `NodeWorkflowRuntime` still applies module and workflow metadata via `applyMetadataScope` (same merge rules for non-locked keys). For predictable agent settings in tests, set `JAIPH_AGENT_*` / `JAIPH_RUNS_DIR` / etc. in the environment, or use `config` in the module that defines the workflow under test.

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
| `run.recover_limit` | `JAIPH_RECOVER_LIMIT` |
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

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh`, `.jaiph/Dockerfile`, and writes `.jaiph/SKILL.md` from the skill file bundled with your installation (see `JAIPH_SKILL_PATH` in the CLI reference). It does not add a separate config file — use `config { ... }` in your workflow sources.
