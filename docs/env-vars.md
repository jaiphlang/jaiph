---
title: Environment variables
permalink: /reference/env-vars
diataxis: reference
redirect_from:
  - /env-vars
  - /env-vars.md
---

# Environment variables

This page is the canonical inventory of every environment variable Jaiph reads from process state. It aggregates `JAIPH_*` variables read by the TypeScript runtime/CLI (`src/`), the vendor credentials Jaiph checks before launching workflows, and the host-side variables the installer script consumes.

For role-oriented overviews see [Configuration](configuration.md), [CLI](cli.md), and [Sandboxing](sandboxing.md). For the credential pre-flight contract see [Authenticate agent backends](/how-to/agent-auth).

Symbols used below:

- **Type** — `string`, `path`, `bool` (the literal text `"true"` / `"1"` enables; anything else disables, with per-variable rules noted), `int` (decimal milliseconds or seconds), `int-list` (comma-separated non-negative integers).
- **Scope** — `host` = read by the host CLI before spawning the runner; `runtime` = read inside the workflow runner (and inside the Docker container when forwarded); `internal` = set automatically by the CLI on the child process and must not be exported manually.
- **Default** — `—` means the variable has no built-in default (an absent value disables the feature, or the surrounding code falls back to a config-key default).

## Runtime, CLI, and internal variables

The table below covers every `JAIPH_*` name read from `process.env` / `env` in `src/`. It is bidirectionally pinned by the docs-lint harness — a `JAIPH_*` name added or removed in source must be added or removed here in the same change.

<!-- begin: src-parity -->

| Variable | Scope | Type | Default | Related config | Role |
|---|---|---|---|---|---|
| `JAIPH_AGENT_BACKEND` | host, runtime | string (`cursor`, `claude`, `codex`) | `cursor` | `agent.backend` | Selects the `prompt` backend. Locked once seen in the parent env. |
| `JAIPH_AGENT_BACKEND_LOCKED` | internal | bool | — | — | Set to `1` by the CLI when `JAIPH_AGENT_BACKEND` was inherited; blocks lower-precedence layers from overriding. |
| `JAIPH_AGENT_CLAUDE_FLAGS` | host, runtime | string (whitespace-split) | — | `agent.claude_flags` | Extra flags appended to the Claude CLI invocation. |
| `JAIPH_AGENT_CLAUDE_FLAGS_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_CLAUDE_FLAGS`. |
| `JAIPH_AGENT_COMMAND` | host, runtime | string | `cursor-agent` | `agent.command` | Executable line for the Cursor backend. A basename other than `cursor-agent` selects custom-command mode (stdin → command → stdout). |
| `JAIPH_AGENT_COMMAND_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_COMMAND`. |
| `JAIPH_AGENT_CURSOR_FLAGS` | host, runtime | string (whitespace-split) | — | `agent.cursor_flags` | Extra flags appended to the Cursor backend invocation. |
| `JAIPH_AGENT_CURSOR_FLAGS_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_CURSOR_FLAGS`. |
| `JAIPH_AGENT_MODEL` | host, runtime | string | — | `agent.default_model` | Default model for `prompt` steps. |
| `JAIPH_AGENT_MODEL_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_MODEL`. |
| `JAIPH_AGENT_TRUSTED_WORKSPACE` | host, runtime | path | workspace root | `agent.trusted_workspace` | Directory passed to Cursor as `--trust`. Rewritten to `/jaiph/workspace`-relative on Docker forwarding when inside the workspace. |
| `JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_TRUSTED_WORKSPACE`. |
| `JAIPH_ARTIFACTS_DIR` | runtime | path | `<run_dir>/artifacts` | — | Absolute path to the writable artifacts directory for the current run. Set by the runtime; read by `jaiphlang/artifacts` and user scripts. |
| `JAIPH_CODEX_API_URL` | runtime | string | `https://api.openai.com/v1/chat/completions` | — | Chat-completions endpoint for the `codex` backend. |
| `JAIPH_DEBUG` | host, runtime | bool (exact `"true"`) | `false` | `run.debug` | Enable debug tracing for the run. |
| `JAIPH_DEBUG_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_DEBUG`. |
| `JAIPH_DOCKER_ENABLED` | host | bool (exact `true`) | — | — | Force Docker on (`true`) or off (any other value). When unset, Docker is on unless `JAIPH_UNSAFE=true`. |
| `JAIPH_DOCKER_IMAGE` | host | string | `ghcr.io/jaiphlang/jaiph-runtime:<version>` | `runtime.docker_image` | Container image. Must already contain `jaiph`. |
| `JAIPH_DOCKER_KEEP_SANDBOX` | host | bool (`1` / `true`) | `false` | — | Copy mode only — when enabled, leave the host-side `.sandbox-<id>/` clone on disk after exit for debugging. |
| `JAIPH_DOCKER_NETWORK` | host | string (`default`, `none`, or named network) | `default` | `runtime.docker_network` | `docker run --network` value. `none` disables egress. |
| `JAIPH_DOCKER_NO_OVERLAY` | host | bool (`1` / `true`) | `false` | — | Force copy mode even when `/dev/fuse` is available. |
| `JAIPH_DOCKER_TIMEOUT` | host | int (seconds) | `14400` (4h) | `runtime.docker_timeout_seconds` | Container execution timeout. `0` disables. Invalid values produce `E_DOCKER_TIMEOUT`. |
| `JAIPH_INBOX_MAX_DISPATCH` | runtime | int | `1000` | — | Maximum inbox messages a single workflow frame may drain before aborting with `E_INBOX_DISPATCH_LIMIT`. |
| `JAIPH_INBOX_PARALLEL` | — | — | — | — | Unused — the runtime does not read this variable (tests assert setting it has no effect on inbox dispatch order). |
| `JAIPH_INPLACE` | host | bool (`1` / `true`) | `false` | — | Opt into inplace sandbox mode (host workspace bind-mounted read-write). Not forwarded into the container. |
| `JAIPH_INPLACE_YES` | host | bool (`1` / `true`) | `false` | — | Auto-confirm the inplace destructive-edit prompt. Required when `JAIPH_INPLACE` is set and stdin is not a TTY. Not forwarded into the container. |
| `JAIPH_INSTALL_COMMAND` | host | string | `curl -fsSL https://jaiph.org/install \| bash` | — | Command `jaiph use` re-invokes to reinstall. |
| `JAIPH_LIB` | host | path | — | — | Removed from the product. The CLI strips it from the launched env before each run. |
| `JAIPH_META_FILE` | internal | path | — | — | Absolute path to the run-metadata file. Set on the detached workflow runner child; stripped from the parent env before launch. |
| `JAIPH_MOCK_PROMPT_ARMS_JSON` | runtime | string (JSON) | — | — | Test-only — injects a mock-arm dispatch table for `prompt` steps. Set by `jaiph test`. |
| `JAIPH_MOCK_RESPONSES_JSON` | runtime | string (JSON) | — | — | Test-only — supplies sequential mock prompt responses. Set by `jaiph test`. |
| `JAIPH_MODULE_GRAPH_FILE` | internal | path | — | — | Absolute path to the serialized `ModuleGraph` JSON. Set by the CLI only on the default local (non-Docker, non-`--raw`) `jaiph run` path. |
| `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` | host | int (seconds) | `60` | — | Seconds before the first non-TTY heartbeat line. |
| `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` | host | int (ms; floor `250`) | `30000` | — | Minimum interval between subsequent non-TTY heartbeat lines. |
| `JAIPH_PRECEDING_FILES` | host | string | — | — | Removed from the product. Stripped from the launched env. |
| `JAIPH_PROMPT_COMPLETION_GRACE_SECONDS` | runtime | int (seconds) | `30` | — | Prompt watchdog — once the backend emits its terminal `result` event, the grace period it may take to exit before Jaiph terminates it and returns success. Guards the case where `claude -p` finishes the work but never exits. `0` disables. |
| `JAIPH_PROMPT_FINAL_FILE` | runtime | path | — | — | Optional path; when set, `executePrompt` writes the final assistant message there. Jaiph does not set this automatically. |
| `JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS` | runtime | int (seconds) | `900` (15m) | — | Prompt watchdog — terminate the backend and fail the prompt (feeding the retry backoff) when it produces no stdout/stderr for this long. `0` disables. |
| `JAIPH_PROMPT_MAX_SECONDS` | runtime | int (seconds) | `7200` (2h) | — | Prompt watchdog — absolute wall-clock cap on a single prompt invocation regardless of activity; on expiry the backend is terminated and the prompt fails into the retry backoff. `0` disables. |
| `JAIPH_PROMPT_RETRY` | runtime | bool (`0` disables) | enabled | — | Set to `0` to skip the prompt retry backoff. `jaiph test` defaults to `0` so mock failures fail fast. |
| `JAIPH_PROMPT_RETRY_DELAYS` | runtime | int-list (ms) | `15000,60000,600000,1800000,7200000` | — | Override the prompt retry delay schedule. Invalid entries abort the prompt. |
| `JAIPH_REGISTRY` | host | path or URL | `https://jaiph.org/registry` | — | Source of the lib registry index used by `jaiph install <name>`. Disk paths (no scheme or `file://`) are read locally; everything else is fetched. |
| `JAIPH_RUN_DIR` | internal | path | — | — | Absolute path to the active run directory. Set by the runtime inside the runner. |
| `JAIPH_RUN_ID` | internal | string (UUID) | runner-generated | — | Stable run identifier. Set by the host CLI on the default (non-`--raw`) `jaiph run` path; otherwise the runner generates one at startup. Forwarded into Docker when set. |
| `JAIPH_RUN_SUMMARY_FILE` | internal | path | `<run_dir>/run_summary.jsonl` | — | Absolute path the runtime writes durable summary events to. |
| `JAIPH_RUNS_DIR` | host, runtime | path | `.jaiph/runs` under the workspace | `run.logs_dir` | Root directory for run logs. Inside Docker the host CLI overrides this to `/jaiph/run`. |
| `JAIPH_RUNS_DIR_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_RUNS_DIR`. |
| `JAIPH_SCRIPTS` | internal | path | — | — | Directory of emitted `script` files for this run. Set after `buildScripts()`. Any parent-shell value is cleared before launch. |
| `JAIPH_SKILL_PATH` | host | path | — | — | When set and the path exists, `jaiph init` writes `.jaiph/SKILL.md` from that file. Otherwise the CLI walks an install-relative search. |
| `JAIPH_SOURCE_ABS` | internal | path | — | — | Absolute path to the entry `.jh` file. Set by the CLI before spawning the runner. |
| `JAIPH_SOURCE_FILE` | internal | string (basename) | entry-file basename | — | Used to name run directories. |
| `JAIPH_STDLIB` | host | path | — | — | Removed from the product. Stripped from the launched env. |
| `JAIPH_TEST_MODE` | runtime | bool (exact `"1"`) | `false` | — | Set by `jaiph test` so the runtime skips production-only branches (e.g. file-mode normalization). |
| `JAIPH_UNSAFE` | host | bool (`true` only) | `false` | — | Disable Docker for this run; execute on the host. `--unsafe` is the `jaiph run` flag form. |
| `JAIPH_WORKSPACE` | host, runtime | path | autodetected | — | Workspace root. Inside Docker the host CLI overrides this to `/jaiph/workspace`. |

<!-- end: src-parity -->

## Agent credentials

The host CLI checks these before spawning the runner or container when [credential pre-flight](configuration.md#credential-pre-flight) applies. Pre-flight is skipped when the entry file declares no explicit backend and uses no `prompt` step, on `jaiph run --raw`, and when `JAIPH_UNSAFE=true`. See [Authenticate agent backends](/how-to/agent-auth) for per-backend rules and [Sandboxing](sandboxing.md) for which credentials cross the container boundary.

| Variable | Backend | Host behaviour | Docker behaviour | Notes |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | `claude` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | Either this **or** `CLAUDE_CODE_OAUTH_TOKEN` satisfies Claude. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | Long-lived OAuth token from `claude setup-token`. |
| `CURSOR_API_KEY` | `cursor` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | A stored `cursor-agent login` may still work on host runs. |
| `OPENAI_API_KEY` | `codex` | hard error (`E_AGENT_CREDENTIALS`) | hard error (`E_AGENT_CREDENTIALS`) | No CLI-login fallback. `OPENAI_*` is outside the Docker forwarding allowlist, so sandboxed runs fail preflight even when the key is set on the host. |

Forwarding allowlist prefixes into the Docker container: `JAIPH_*` (except `JAIPH_DOCKER_*`, `JAIPH_INPLACE`, and `JAIPH_INPLACE_YES`), `ANTHROPIC_*`, `CLAUDE_*`, `CURSOR_*`. Everything else — including `OPENAI_*` — is silently dropped — see [Sandboxing](sandboxing.md).

## Installer and `jaiph use`

These variables are consumed by `docs/install` (the installer shell script) and by `jaiph use` when it re-invokes the installer. They are **not** read from inside the Jaiph TypeScript source.

| Variable | Type | Default | Role |
|---|---|---|---|
| `JAIPH_REPO_REF` | string | `v0.10.0` (installer default when unset) | Release ref the installer downloads (`v0.10.0`, `nightly`, …). `jaiph use <version>` sets this to `v<version>` or `nightly`. |
| `JAIPH_BIN_DIR` | path | `$HOME/.local/bin` | Target bin directory for the installed `jaiph` binary. |
| `JAIPH_RELEASE_BASE_URL` | string | `https://github.com/jaiphlang/jaiph/releases/download/<ref>` | Override the GitHub Release base URL the installer downloads from. |
| `JAIPH_REPO_URL` | path | — | Local repo path (directory containing `package.json`) for the from-source installer branch (`docs/install-from-local.sh`). Ignored on the binary-download path. |

## Docker sandbox failure modes

These error codes surface during Docker-backed `jaiph run` invocations. They are emitted to stderr (and to the failure footer) and produce non-zero exit codes. Most are `E_DOCKER_*`; `E_TIMEOUT`, `E_VALIDATE_MOUNT`, and `E_FLAG_CONFLICT` appear in Docker contexts but are not strictly Docker-scoped.

| Code | Trigger | Behaviour |
|---|---|---|
| `E_DOCKER_NOT_FOUND` | `docker info` fails (Docker not installed or daemon not running). | Run exits before launch. No fallback to local execution. |
| `E_DOCKER_PULL` | `docker pull` fails (network error, image not found, auth failure). | Run exits before launch. |
| `E_DOCKER_NO_JAIPH` | Selected image does not contain a `jaiph` CLI. | Run exits before launch. |
| `E_DOCKER_RUNS_DIR` | Absolute `JAIPH_RUNS_DIR` points outside the workspace. | Run exits before launch. |
| `E_DOCKER_OVERLAY` | Overlay mode selected but `fuse-overlayfs` is missing or the mount fails. | Container exits with code 78. |
| `E_DOCKER_TIMEOUT` | `JAIPH_DOCKER_TIMEOUT` is empty, non-numeric, negative, or has trailing junk; or `runtime.docker_timeout_seconds` is negative. | Run exits before launch. |
| `E_DOCKER_UID` | Linux host UID/GID detection failed. | Run exits before launch. |
| `E_DOCKER_SANDBOX_COPY` | Copy mode failed to clone the host workspace. | Run exits before launch. |
| `E_DOCKER_INPLACE_NO_CONFIRM` | `JAIPH_INPLACE` is set but stdin is not a TTY and `JAIPH_INPLACE_YES` is not set. | Run exits before launch. |
| `E_FLAG_CONFLICT` | `--inplace` / `JAIPH_INPLACE` and `--unsafe` / `JAIPH_UNSAFE=true` are both set. | Run exits before launch. |
| `E_VALIDATE_MOUNT` | Mount targets a denied host path (`/`, `/proc`, docker socket, etc.). | Run exits before launch. |
| `E_TIMEOUT` | Container runs longer than the effective Docker timeout. | Container receives SIGTERM, then SIGKILL after 5s grace. |
| `E_AGENT_CREDENTIALS` | Credential pre-flight detected a missing agent credential. | Run exits before launch. |

## Related

- [Configuration](configuration.md) — config keys and their environment-variable equivalents.
- [CLI](cli.md) — commands and flags that front-end these variables.
- [Sandboxing](sandboxing.md) — what the Docker sandbox protects and what it does not.
