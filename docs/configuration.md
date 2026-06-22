---
title: Configuration
permalink: /reference/configuration
diataxis: reference
redirect_from:
  - /configuration
  - /configuration.md
---

# Configuration

This page is the authoritative inventory of Jaiph configuration keys: every key, its value type, default, environment-variable equivalent, and precedence. For environment-variable details (defaults, scopes, sandbox forwarding) see [Environment variables](env-vars.md). For the CLI flags that front-end the same knobs see [CLI](cli.md).

Configuration sources, in priority order:

1. **Environment variables** — locked once observed by the host CLI; see [Locked variables](#locked-variables).
2. **Workflow-level `config { … }`** — applies for the duration of that workflow.
3. **Module-level `config { … }`** — applies to all workflows in that file unless overridden.
4. **Built-in defaults** — lowest priority.

Docker enablement uses a separate, env-only resolution; see [Docker enablement](#docker-enablement).

## Config block syntax

| Aspect | Rule |
|---|---|
| Module-level | At most one `config { … }` block per `.jh` file. May appear anywhere among top-level constructs. |
| Workflow-level | At most one nested `config { … }` per workflow body. Must be the first non-comment construct in the body. |
| Allowed module keys | `agent.*`, `run.*`, `runtime.*`, `module.*`. |
| Allowed workflow keys | `agent.*`, `run.*` only. `runtime.*` and `module.*` are `E_PARSE`. |
| Duplicate block | `E_PARSE duplicate config block (only one allowed per file)` / `E_PARSE duplicate config block inside workflow (only one allowed per workflow)`. |
| Unknown key | `E_PARSE unknown config key: <key>. Allowed: …` (lists every allowed key). |
| Wrong value type | `E_PARSE`. |

### Value syntax

| Type | Format | Example |
|---|---|---|
| String | Double-quoted; supports `\\`, `\n`, `\t`, `\"` | `"gpt-4"` |
| Boolean | Bare `true` / `false` | `true` |
| Integer | Unsigned decimal digits | `300` |

## Agent keys

| Key | Type | Default | Env equivalent | Notes |
|---|---|---|---|---|
| `agent.default_model` | string | — | `JAIPH_AGENT_MODEL` | Default model for `prompt` steps. Applies to all backends. |
| `agent.command` | string | `cursor-agent` | `JAIPH_AGENT_COMMAND` | Cursor backend command. Basename other than `cursor-agent` enables custom-command mode (stdin → command → stdout). |
| `agent.backend` | string (`cursor` \| `claude` \| `codex`) | `cursor` | `JAIPH_AGENT_BACKEND` | Backend selector. |
| `agent.trusted_workspace` | string (path) | workspace root | `JAIPH_AGENT_TRUSTED_WORKSPACE` | Directory passed to Cursor as `--trust`. When unset, defaults to `JAIPH_WORKSPACE`. In-file values are assigned to the env var as authored (relative paths are not normalized to absolute paths). |
| `agent.cursor_flags` | string | — | `JAIPH_AGENT_CURSOR_FLAGS` | Extra flags appended to Cursor invocations (whitespace-split). |
| `agent.claude_flags` | string | — | `JAIPH_AGENT_CLAUDE_FLAGS` | Extra flags appended to Claude invocations (whitespace-split). |

## Run keys

| Key | Type | Default | Env equivalent | Notes |
|---|---|---|---|---|
| `run.logs_dir` | string (path) | `.jaiph/runs` | `JAIPH_RUNS_DIR` | Step log directory. Relative paths join the workspace root; absolute paths are used as-is. |
| `run.debug` | boolean | `false` | `JAIPH_DEBUG` | Enable debug tracing. |
| `run.recover_limit` | integer | `10` | — (no env override) | Maximum attempts for `run … recover` loops before the step fails. Resolves via workflow > module > default. |

## Module keys

Informational metadata only; does not affect execution. Allowed in module-level config only — any `module.*` key inside a workflow-level config is `E_PARSE`.

| Key | Type | Default |
|---|---|---|
| `module.name` | string | — |
| `module.version` | string | — |
| `module.description` | string | — |

## Runtime (Docker) keys

These configure the Docker sandbox. Allowed in **module-level** config only. They are read by the host CLI when it considers a Docker launch (`resolveDockerConfig` in `src/runtime/docker.ts`) and never affect `NodeWorkflowRuntime` directly. **Docker on/off is not a `runtime.*` key** — see [Docker enablement](#docker-enablement).

| Key | Type | Default | Env equivalent | Notes |
|---|---|---|---|---|
| `runtime.docker_image` | string | `ghcr.io/jaiphlang/jaiph-runtime:<version>` | `JAIPH_DOCKER_IMAGE` | Container image. Must already contain `jaiph` (`E_DOCKER_NO_JAIPH` otherwise). |
| `runtime.docker_network` | string | `default` | `JAIPH_DOCKER_NETWORK` | `docker run --network` value. `none` disables egress. |
| `runtime.docker_timeout_seconds` | integer | `14400` | `JAIPH_DOCKER_TIMEOUT` | Container execution timeout in seconds. `0` disables. Negative or invalid env value produces `E_DOCKER_TIMEOUT`. |

In-file `runtime.docker_enabled` is not supported (`E_PARSE`); use the env-only enablement below.

## Docker enablement

| Check | Result |
|---|---|
| `JAIPH_DOCKER_ENABLED` is set to exact `true` | Docker on. |
| `JAIPH_DOCKER_ENABLED` is set to any other value | Docker off. |
| `JAIPH_DOCKER_ENABLED` is unset and `JAIPH_UNSAFE=true` | Docker off. |
| Default (no env) | Docker on. |

`CI=true` does not change this default. Host `jaiph run --raw` never consults this branch — the workflow runner is local in that path. See [Sandboxing](sandboxing.md) for the full model.

## Precedence
{: #precedence}

### Agent and run keys

| Layer | Effect |
|---|---|
| Environment (`JAIPH_AGENT_*`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`) | Locked when present in the parent env; cannot be overridden by module- or workflow-level config. |
| Workflow-level `config` | Applies for the workflow body; restored on exit. |
| Module-level `config` | Applies to workflows without their own block. |
| Built-in defaults | Lowest priority. |

### Runtime (Docker) keys

| Layer | Effect |
|---|---|
| Environment (`JAIPH_DOCKER_*`) | Highest priority for `image`, `network`, `timeout`. |
| Module-level `config` (`runtime.*`) | Applies when no env override is set. |
| Built-in defaults | Lowest priority. |

Workflow-level `config` cannot set `runtime.*` keys.

### Scoping across nested calls

| Call type | Scope behaviour |
|---|---|
| Root entry (`jaiph run file.jh`) | Full module + workflow metadata applied with normal precedence. |
| Same-module `run` | Callee's workflow-level `config` is layered on top of the caller's effective env. Module-level config is not re-applied. |
| Cross-module `run` (e.g. `run alias.default()`) | Callee's module-level config is layered, then workflow-level on top — same as root-entry precedence, respecting `${NAME}_LOCKED`. |
| Same-module `ensure` | Caller's scope is reused verbatim. |
| Cross-module `ensure` | Callee module's `agent.*` / `run.*` are merged on top of the current env (respecting locks). Workflow-level config does not apply to rules. |

After any nested call returns, the caller's scope is restored exactly as before.

## Locked variables
{: #locked-variables}

When the host CLI builds the runner environment, any of these variables already present in `process.env` gets a matching `${NAME}_LOCKED=1` flag set on the child env. The runtime refuses to overwrite a locked value from later metadata merges.

Locked names: `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`.

## Config-to-env mapping

| In-file key | Environment variable |
|---|---|
| `agent.default_model` | `JAIPH_AGENT_MODEL` |
| `agent.command` | `JAIPH_AGENT_COMMAND` |
| `agent.backend` | `JAIPH_AGENT_BACKEND` |
| `agent.trusted_workspace` | `JAIPH_AGENT_TRUSTED_WORKSPACE` |
| `agent.cursor_flags` | `JAIPH_AGENT_CURSOR_FLAGS` |
| `agent.claude_flags` | `JAIPH_AGENT_CLAUDE_FLAGS` |
| `run.logs_dir` | `JAIPH_RUNS_DIR` |
| `run.debug` | `JAIPH_DEBUG` |
| `run.recover_limit` | _(no env override)_ |
| `runtime.docker_image` | `JAIPH_DOCKER_IMAGE` |
| `runtime.docker_network` | `JAIPH_DOCKER_NETWORK` |
| `runtime.docker_timeout_seconds` | `JAIPH_DOCKER_TIMEOUT` |
| `module.name` | _(no env override)_ |
| `module.version` | _(no env override)_ |
| `module.description` | _(no env override)_ |

Variables with no in-file equivalent: `JAIPH_CODEX_API_URL` (codex endpoint), `JAIPH_PROMPT_RETRY` / `JAIPH_PROMPT_RETRY_DELAYS` (prompt-retry schedule), `OPENAI_API_KEY` (codex credential). Full inventory in [Environment variables](env-vars.md).

## Backend selection
{: #backend-selection}

| Backend | Required credential | Endpoint / CLI |
|---|---|---|
| `cursor` (default) | `CURSOR_API_KEY` (or stored `cursor-agent login` on host runs) | Runs `agent.command` (default `cursor-agent`) with `stream-json` framing. |
| `claude` | `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` (or stored Claude CLI login on host runs) | Runs `claude` on `PATH`. |
| `codex` | `OPENAI_API_KEY` | Calls the OpenAI Chat Completions endpoint directly (`JAIPH_CODEX_API_URL` overrides the URL). No CLI-login fallback. |

Backend-specific flags come from `agent.cursor_flags` / `agent.claude_flags` (or the matching env vars). There is no per-`prompt` backend override.

### Credential pre-flight
{: #credential-pre-flight}

Before `jaiph run` spawns the workflow runner or Docker container, the host CLI runs a credential pre-flight (`src/cli/run/preflight-credentials.ts`). It collects the distinct backend(s) declared in the entry file's module-level `config` block and each workflow-level block, plus the effective default (`JAIPH_AGENT_BACKEND` env, or `cursor` when unset). Deeper per-import overrides resolved at runtime are not followed.

| Backend | Required credential | Host run (no Docker) | Docker run (any mode incl. `inplace`) |
|---|---|---|---|
| `codex` | `OPENAI_API_KEY` | hard error (`E_AGENT_CREDENTIALS`) | hard error (`E_AGENT_CREDENTIALS`) |
| `claude` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | warn (CLI login may still work) | hard error (`E_AGENT_CREDENTIALS`) |
| `cursor` | `CURSOR_API_KEY` | warn (CLI login may still work) | hard error (`E_AGENT_CREDENTIALS`) |

Hard errors exit non-zero with no runner or container launched. Warnings go to stderr and the run proceeds. Skip cases: entry file declares no explicit backend and uses no `prompt` step → no pre-flight; `jaiph run --raw` → no pre-flight; `JAIPH_UNSAFE=true` / `--unsafe` → no pre-flight (host escape hatch — runtime backend guards remain).

Every error and warning names: the backend; the model when `agent.default_model` is set; the entry `.jh` file; the config scope (`module config`, `workflow <name>`, `JAIPH_AGENT_BACKEND env`, or `default`); and the concrete remedy. Docker-mode messages also note that the variable must be set on the host so it gets forwarded.

## Model resolution
{: #model-resolution}

Resolution order for a `prompt` step:

| Step | Source | Notes |
|---|---|---|
| 1 | Explicit model — `agent.default_model` / `JAIPH_AGENT_MODEL` non-empty. | `model_reason: explicit`. |
| 2 | Flags model — `--model <name>` inside `agent.cursor_flags` / `agent.claude_flags`. | `model_reason: flags`. Codex has no flag channel; this step does not apply. |
| 3 | Backend default — Cursor/Claude binaries pick their own. Codex defaults to `gpt-4o` in code. | `model_reason: backend-default`. |

For the Claude backend, when `agent.default_model` is set and `agent.claude_flags` does not already contain `--model`, Jaiph passes `--model <value>` to the Claude CLI automatically. If both are set, the value in `agent.claude_flags` wins (appended last).

`PROMPT_START` / `PROMPT_END` records in `run_summary.jsonl` carry `model` (resolved string, or null when backend auto-selects) and `model_reason`.

## Prompt retry on transport failure
{: #prompt-retry-on-transport-failure}

`NodeWorkflowRuntime` retries transport-failed prompt invocations on an escalating backoff schedule before propagating the failure to any enclosing `recover` / `catch`.

| Attempt | Delay before this attempt |
|---|---|
| 1 | _(none — initial call)_ |
| 2 | 15s |
| 3 | 1m |
| 4 | 10m |
| 5 | 30m |
| 6 | 2h |

Total worst-case wall-clock: ~2h41m. Under Docker, `runtime.docker_timeout_seconds` caps this.

Only transport failures are retried (non-zero exit from cursor/claude, codex HTTP error, spawn failure). Deterministic post-processing failures — invalid JSON, schema validation — fail on the first attempt and return `{ ok: false }`.

Each attempt emits its own `PROMPT_START` / `PROMPT_END` and `STEP_START` / `STEP_END`. Each failure logs a `LOGERR` line; the final termination logs another. The captured value reflects the successful attempt.

| Variable | Effect |
|---|---|
| `JAIPH_PROMPT_RETRY=0` | Disable retry entirely (one attempt, fail on transport failure). |
| `JAIPH_PROMPT_RETRY_DELAYS` | Comma-separated list of non-negative integer milliseconds. Invalid entries abort the prompt. |

`jaiph test` defaults `JAIPH_PROMPT_RETRY=0`. Backoff sleep is interruptible: workflow abort, SIGINT, or SIGTERM cancels the pending wait without further backend calls.

## Prompt watchdog timeouts
{: #prompt-watchdog-timeouts}

The retry backoff above handles a backend that *fails*. A separate set of watchdogs handles a backend that *hangs* — it never exits, so without them the runtime would block on the subprocess indefinitely (no commit, no queue progress, no retry). Each prompt invocation installs three independent layers over the spawned backend process:

| Layer | Variable | Default | Trigger | Outcome |
|---|---|---|---|---|
| Completion grace | `JAIPH_PROMPT_COMPLETION_GRACE_SECONDS` | `30` | The backend emitted its terminal `result` event (work is done) but the process has not exited within the grace window. | Terminate the process, return **success** with the captured answer. |
| Idle timeout | `JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS` | `900` (15m) | No stdout/stderr for the whole window — the backend is stuck mid-work. | Terminate the process, return **failure** → feeds the [retry backoff](#prompt-retry-on-transport-failure). |
| Absolute cap | `JAIPH_PROMPT_MAX_SECONDS` | `7200` (2h) | Total wall-clock for the single invocation exceeds the cap, regardless of activity. | Terminate the process, return **failure** → feeds the retry backoff. |

Set any variable to `0` to disable that layer. The idle timer resets on every chunk of backend output, so a slow-but-active run is bounded only by the absolute cap.

The completion-grace layer specifically addresses the known `claude -p` failure mode where the CLI streams its final answer (and the terminal `result` event) but the process never exits — often because a descendant it spawned is still holding the output pipe open. When a watchdog fires it sends `SIGTERM`, escalating to `SIGKILL` after 5s, and tears down the runtime's handles on the child's stdio so a lingering descendant cannot keep the run alive. Under Docker, `runtime.docker_timeout_seconds` remains the outer backstop for the whole container.

## Custom agent commands

`agent.command` is consumed by the **cursor** backend only. For `claude` and `codex`, Jaiph always invokes the Claude CLI or the codex HTTP path, regardless of `agent.command`.

When `agent.backend = "cursor"` and `agent.command`'s basename is anything other than `cursor-agent`, Jaiph treats it as a custom agent command:

| Channel | Behaviour |
|---|---|
| stdin | Prompt text piped to the command. |
| stdout | Captured as the prompt response (raw text, no JSON framing). |
| stderr | Passes through to the terminal. |
| Cursor-specific flags (`--output-format`, `--stream-partial-output`, `--workspace`, …) | Not appended. |
| Step display name | Command basename instead of `cursor`. |

Custom commands still participate in `PROMPT_START` / `PROMPT_END`, write artifacts, and apply `returns` schema validation when configured.

## Test runner

`jaiph test` does not call `resolveRuntimeEnv`. The test runner spreads `process.env`, then sets `JAIPH_TEST_MODE`, `JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR` (ephemeral), `JAIPH_SCRIPTS`, and mock fields (`JAIPH_MOCK_RESPONSES_JSON`, `JAIPH_MOCK_PROMPT_ARMS_JSON`). `JAIPH_*_LOCKED` flags are not set unless inherited from the parent env. `NodeWorkflowRuntime` still applies in-file `config` via `applyMetadataScope` with the same lock rules.

## Inspecting effective config at runtime

Agent and run settings are visible inside workflows, rules, and scripts as `JAIPH_*` environment variables. In orchestration strings, `${IDENT}` resolves against workflow bindings first, then against the process environment.

`JAIPH_DOCKER_*` variables are not populated from in-file `runtime.*` inside the workflow runner. Docker config is consumed when the CLI spawns the runner (or container); if a script needs Docker-related variables in its environment, export them from the parent shell.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh`, `.jaiph/SKILL.md`, and `.jaiph/.gitignore`. There is no separate config file — `config { … }` blocks live in workflow source. See [CLI — `jaiph init`](cli.md#jaiph-init).

## Related

- [Environment variables](env-vars.md) — every variable Jaiph reads.
- [CLI](cli.md) — flags that front-end these config knobs.
- [Sandboxing](sandboxing.md) — Docker sandbox model.
- [Grammar](grammar.md) — `config` block syntax in the formal grammar.
