---
title: Environment variables
permalink: /reference/env-vars
diataxis: reference
redirect_from:
  - /env-vars
  - /env-vars.md
---

# Environment variables

This page lists every environment variable Jaiph reads. It covers the `JAIPH_*` variables the TypeScript runtime and CLI read (`src/`), the vendor credentials Jaiph checks before it launches a workflow, and the host-side variables the installer script reads.

For role-oriented overviews see [Configuration](configuration.md), [CLI](cli.md), and [Sandboxing](sandboxing.md). For the credential pre-flight contract see [Authenticate agent backends](agent-auth.md).

The tables below use three symbols.

- **Type**. `string`, `path`, `bool` (the literal text `"true"` or `"1"` enables it, anything else disables it, with per-variable rules noted), `int` (decimal milliseconds or seconds), and `int-list` (comma-separated non-negative integers).
- **Scope**. `host` means the host CLI reads it before it spawns the runner. `runtime` means the workflow runner reads it, and so does the Docker container when the value is forwarded. `internal` means the CLI sets it automatically on the child process, and you must not export it by hand.
- **Default**. `—` means the variable has no built-in default. An absent value then disables the feature, or the surrounding code falls back to a config-key default.

## Runtime, CLI, and internal variables

The table below covers every `JAIPH_*` name read from `process.env` or `env` in `src/`. The docs-lint harness keeps the table and the source in sync in both directions. When you add or remove a `JAIPH_*` name in the source, you must add or remove it here in the same change.

### Precedence

`jaiph run`, `jaiph serve`, and `jaiph mcp` share one execution-policy contract. For every policy input the resolution order is:

1. **CLI flags** (`--workspace`, `--env`, `--inplace`, `--unsafe`, `--yes`). A flag sets the corresponding `JAIPH_*` variable on that process's launched env, so the env layer below stays the single source Jaiph reads when it resolves the sandbox.
2. **`JAIPH_*` environment variables** (this table).
3. **Workflow runtime metadata**, from the entry file's `config { runtime { … } }` keys such as `docker_image` and `docker_network`. This layer is untrusted (repo- or model-supplied): `docker_image` and isolation-breaking `docker_network` values (`host`, `container:*`, `ns:*`) are **host-controlled** — a file-declared value is rejected when Docker is the active sandbox (`E_DOCKER_IMAGE_HOST_ONLY` / `E_DOCKER_NETWORK_HOST_ONLY`), so only the env layer above can set them (finding M-6).
4. **Built-in defaults.**

Precedence never resolves a contradiction between the two sandbox postures. Setting `--inplace` or `JAIPH_INPLACE` together with `--unsafe` or `JAIPH_UNSAFE` fails with `E_FLAG_CONFLICT` before Jaiph spawns anything, in all three commands.

The long-lived servers `jaiph serve` and `jaiph mcp` resolve the effective posture once at startup, print it, and apply it to every call. `jaiph run` resolves it once per run.

The consent rules differ by command. `jaiph run` confirms inplace and unsafe host-only mode interactively, and `--yes` or `JAIPH_INPLACE_YES` auto-confirms it (required when stdin is not a TTY). `jaiph serve` and `jaiph mcp` never prompt. For inplace and the default sandbox, launching the server with the flag or the environment variable is the consent. Unsafe host-only mode needs more: the server requires the explicit `--unsafe` (or `--yes`) flag on its own command line, and an inherited `JAIPH_UNSAFE=true` with no such flag is refused at startup with `E_UNSAFE_NO_CONSENT`, so a stray value left in a shell profile cannot silently switch a server to host-only. When you give that consent, the server prints a prominent multi-line banner that states sandboxing is disabled.

Inside a container the container is the sandbox, so unsafe host-only mode proceeds without the explicit flag (the server modes skip the refusal), which is the standalone posture the runtime image is built for. `jaiph run` prints a one-line notice there, and `jaiph serve` and `jaiph mcp` still print the startup banner.

<!-- begin: src-parity -->

| Variable | Scope | Type | Default | Related config | Role |
|---|---|---|---|---|---|
| `JAIPH_AGENT_BACKEND` | host, runtime | string (`cursor`, `claude`, `codex`) | `cursor` | `agent.backend` | Selects the `prompt` backend. Locked once seen in the parent env. |
| `JAIPH_AGENT_BACKEND_IMPORT_UNLOCK` | host | bool | — | — | Set to `1` to allow imported modules to set `agent.backend`. Disabled by default; see [Import trust boundary](configuration.md#import-trust-boundary). |
| `JAIPH_AGENT_BACKEND_LOCKED` | internal | bool | — | — | Set to `1` by the CLI when `JAIPH_AGENT_BACKEND` was inherited; blocks lower-precedence layers from overriding. |
| `JAIPH_AGENT_CLAUDE_FLAGS` | host, runtime | string (whitespace-split) | — | `agent.claude_flags` | Extra flags appended to the Claude CLI invocation. |
| `JAIPH_AGENT_CLAUDE_FLAGS_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_CLAUDE_FLAGS`. |
| `JAIPH_AGENT_COMMAND` | host, runtime | string | `cursor-agent` | `agent.command` | Executable line for the Cursor backend. A basename other than `cursor-agent` selects custom-command mode (stdin → command → stdout). |
| `JAIPH_AGENT_COMMAND_IMPORT_UNLOCK` | host | bool | — | — | Set to `1` to allow imported modules to set `agent.command`. Disabled by default; see [Import trust boundary](configuration.md#import-trust-boundary). |
| `JAIPH_AGENT_COMMAND_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_COMMAND`. |
| `JAIPH_AGENT_CURSOR_FLAGS` | host, runtime | string (whitespace-split) | — | `agent.cursor_flags` | Extra flags appended to the Cursor backend invocation. |
| `JAIPH_AGENT_CURSOR_FLAGS_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_CURSOR_FLAGS`. |
| `JAIPH_AGENT_MODEL` | host, runtime | string | — | _(no in-file key — set in shell to override all prompts)_ | Optional run-wide model override for every `prompt` step. In-file `agent.model` does not populate this variable. |
| `JAIPH_AGENT_MODEL_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_MODEL`. |
| `JAIPH_AGENT_TRUSTED_WORKSPACE` | host, runtime | path | workspace root | `agent.trusted_workspace` | Directory passed to Cursor as `--trust`. Rewritten to `/jaiph/workspace`-relative on Docker forwarding when inside the workspace. |
| `JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_AGENT_TRUSTED_WORKSPACE`. |
| `JAIPH_ARTIFACTS_DIR` | runtime | path | `<run_dir>/artifacts` | — | Absolute path to the writable artifacts directory for the current run. Set by the runtime; read by `jaiphlang/artifacts` and user scripts. |
| `JAIPH_CODEX_API_URL` | runtime | string | `https://api.openai.com/v1/chat/completions` | — | Chat-completions endpoint for the `codex` backend. |
| `JAIPH_DEBUG` | host, runtime | bool (exact `"true"`) | `false` | `run.debug` | Enable debug tracing for the run. |
| `JAIPH_DEBUG_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_DEBUG`. |
| `JAIPH_DOCKER_ENABLED` | host | bool (exact `true`) | — | — | Force Docker on (`true`) or off (any other value). When unset, Docker is on unless `JAIPH_UNSAFE=true`. Ignored on Windows (`win32`), where the sandbox is out of scope and runs are always host-only. |
| `JAIPH_DOCKER_IMAGE` | host | string | `ghcr.io/jaiphlang/jaiph-runtime:<version>` | `runtime.docker_image` (host-controlled) | Container image. Must already contain `jaiph`. The in-file `runtime.docker_image` is rejected when Docker is the active sandbox (`E_DOCKER_IMAGE_HOST_ONLY`); only this env var selects a non-default image. |
| `JAIPH_DOCKER_IMAGE_DIGEST` | host | string (`sha256:<64 hex>` or bare 64-hex) | — (unless baked into the release for the default image) | — | Expected manifest digest the resolved sandbox image must match on every run, including cache hits (finding M-6). When set it is trusted and used verbatim; a malformed value is rejected with `E_DOCKER_DIGEST`. A mismatch (a re-pointed tag or a poisoned local cache) fails closed with `E_DOCKER_DIGEST_MISMATCH`. The default official image ships its pinned digest with the release; a custom `JAIPH_DOCKER_IMAGE` is only enforced when you pin it here or as an `@sha256:` reference. |
| `JAIPH_DOCKER_KEEP_SANDBOX` | host | bool (`1` / `true`) | `false` | — | Snapshot mode only — when enabled, leave the host-side workspace snapshot at `<run dir>/sandbox` on disk after exit for debugging. |
| `JAIPH_DOCKER_NETWORK` | host | string (`default`, `none`, or named network) | `default` | `runtime.docker_network` (host-controlled for `host` / `container:*` / `ns:*`) | `docker run --network` value. `none` disables egress. This env var is trusted and used verbatim (it may even be `host`). A file-declared `host` / `container:*` / `ns:*` is rejected (`E_DOCKER_NETWORK_HOST_ONLY`) when Docker is the active sandbox; host-safe in-file values (`default`, `none`, named bridge) are still honoured. |
| `JAIPH_DOCKER_TIMEOUT` | host | int (seconds) | `14400` (4h) | `runtime.docker_timeout_seconds` | Container execution timeout. `0` disables. Invalid values produce `E_DOCKER_TIMEOUT`. |
| `JAIPH_INBOX_MAX_DISPATCH` | runtime | int | `1000` | — | Maximum inbox messages a single workflow frame may drain before aborting with `E_INBOX_DISPATCH_LIMIT`. |
| `JAIPH_INBOX_PARALLEL` | — | — | — | — | Unused — the runtime does not read this variable (tests assert setting it has no effect on inbox dispatch order). |
| `JAIPH_INPLACE` | host | bool (`1` / `true`) | `false` | — | Opt into inplace sandbox mode (host workspace bind-mounted read-write). `--inplace` is the flag form on `jaiph run`, `jaiph serve`, and `jaiph mcp` (flag wins: it sets this variable for that process). Mutually exclusive with `JAIPH_UNSAFE` / `--unsafe` (`E_FLAG_CONFLICT`). Not forwarded into the container. |
| `JAIPH_INPLACE_YES` | host | bool (`1` / `true`) | `false` | — | Auto-confirm the destructive-edit prompt for **both** inplace and unsafe modes (`--yes` / `-y` is the flag form on `jaiph run`, `jaiph serve`, and `jaiph mcp`). Required on `jaiph run` when `JAIPH_INPLACE` **or** the unsafe host-only path (see `JAIPH_UNSAFE`) is active and stdin is not a TTY. `jaiph serve` / `jaiph mcp` never prompt: launching the server with the posture flag is the consent, and the effective posture is printed once at startup. For unsafe host-only, an inherited `JAIPH_UNSAFE=true` alone is **not** consent — the server also requires `--unsafe` or `--yes` on its command line (see `JAIPH_UNSAFE`). Not forwarded into the container. |
| `JAIPH_INSTALL_COMMAND` | host | string | — | — | Operator override for `jaiph use` (forks, offline bundles, local scripts); run as-is. When unset, `jaiph use` fetches `${JAIPH_SITE}/install`, verifies it against `${JAIPH_SITE}/install.sha256`, and only then executes it (a mismatch fails closed). |
| `JAIPH_LIB` | host | path | — | — | Removed from the product. The CLI strips it from the launched env before each run. |
| `JAIPH_MAX_STEPS` | runtime | int | `0` (disabled) | — | Optional max-step circuit breaker. When set to a positive integer, the runtime counts every executed (non-trivia) step across the whole run — loop iterations and nested/recursive calls included — and aborts the run with `E_MAX_STEPS` once the count exceeds the cap, stopping a runaway workflow. `0`, empty, or invalid disables it. |
| `JAIPH_META_FILE` | internal | path | — | — | Absolute path to the run-metadata file. Set on the detached workflow runner child; stripped from the parent env before launch. |
| `JAIPH_MOCK_PROMPT_ARMS_JSON` | runtime | string (JSON) | — | — | Test-only — injects a mock-arm dispatch table for `prompt` steps. Set by `jaiph test`. |
| `JAIPH_MOCK_RESPONSES_JSON` | runtime | string (JSON) | — | — | Test-only — supplies sequential mock prompt responses. Set by `jaiph test`. |
| `JAIPH_MODULE_GRAPH_FILE` | internal | path | — | — | Absolute path to the serialized `ModuleGraph` JSON. Set by the CLI only on the default local (non-Docker, non-`--raw`) `jaiph run` path. |
| `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` | host | int (seconds) | `60` | — | Seconds before the first non-TTY heartbeat line. |
| `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` | host | int (ms; floor `250`) | `30000` | — | Minimum interval between subsequent non-TTY heartbeat lines. |
| `JAIPH_STEP_IDLE_KILL_SEC` | runtime | int (seconds) | `3600` (1h) | — | Seconds without stdout/stderr from a leaf `script` step before the runtime emits a `LOGERR` naming the step and idle duration, terminates the step's subprocess (SIGTERM → SIGKILL), and fails the step, so a stuck leaf that stopped producing output cannot hold the run open indefinitely. Resets on any new output, the same as the warn cadence. `0` disables the kill and leaves warn-only behaviour; an empty or invalid value falls back to the default. Independent of `JAIPH_STEP_IDLE_WARN_SEC`. |
| `JAIPH_STEP_IDLE_WARN_SEC` | runtime | int (seconds) | `180` | — | Seconds without stdout/stderr from a leaf script or prompt step before emitting a `LOGWARN` idle warning (`0` disables). |
| `JAIPH_STEP_IDLE_WARN_CHECK_MS` | runtime | int (ms; floor `250`) | `5000` | — | Poll interval for leaf-step idle warnings. |
| `JAIPH_PRECEDING_FILES` | host | string | — | — | Removed from the product. Stripped from the launched env. |
| `JAIPH_PROMPT_COMPLETION_GRACE_SECONDS` | runtime | int (seconds) | `30` | — | Prompt watchdog — once the backend emits its terminal `result` event, the grace period it may take to exit before Jaiph terminates it and returns success. Guards the case where `claude -p` finishes the work but never exits. `0` disables. |
| `JAIPH_PROMPT_FINAL_FILE` | runtime | path | — | — | Optional path; when set, `executePrompt` writes the final assistant message there. Jaiph does not set this automatically. |
| `JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS` | runtime | int (seconds) | `900` (15m) | — | Prompt watchdog — terminate the backend and fail the prompt (feeding the retry backoff) when it produces no stdout/stderr for this long. `0` disables. |
| `JAIPH_PROMPT_MAX_SECONDS` | runtime | int (seconds) | `7200` (2h) | — | Prompt watchdog — absolute wall-clock cap on a single prompt invocation regardless of activity; on expiry the backend is terminated and the prompt fails into the retry backoff. `0` disables. |
| `JAIPH_PROMPT_RETRY` | runtime | bool (`0` disables) | enabled | — | Set to `0` to skip the prompt retry backoff. `jaiph test` defaults to `0` so mock failures fail fast. |
| `JAIPH_PROMPT_RETRY_DELAYS` | runtime | int-list (ms) | `15000,60000,600000,1800000,7200000` | — | Override the prompt retry delay schedule. Invalid entries abort the prompt. |
| `JAIPH_REGISTRY` | host | path or URL | `https://jaiph.org/registry` | — | Source of the lib registry index used by `jaiph install <name>`. Disk paths (no scheme or `file://`) are read locally and trusted. A remote source must use `https://` or `ssh://` (an `http://` value is rejected) and is signature-verified against a detached `<source>.minisig` before use, so a missing or tampered index fails closed. |
| `JAIPH_RUN_DIR` | internal | path | — | — | Absolute path to the active run directory. Set by the runtime inside the runner. |
| `JAIPH_RUN_ID` | internal | string (UUID) | runner-generated | — | Stable run identifier. Set by the host CLI on the default (non-`--raw`) `jaiph run` path; otherwise the runner generates one at startup. Forwarded into Docker when set. |
| `JAIPH_RUN_SUMMARY_FILE` | internal | path | `<run_dir>/run_summary.jsonl` | — | Absolute path the runtime writes durable summary events to. |
| `JAIPH_RUN_TIMEOUT` | host | int (seconds) | `0` (disabled) | — | Parent-enforced wall-clock timeout for a **host-mode** run (`jaiph run --unsafe` / host-only, and the host spawn used by `jaiph serve` / `jaiph mcp` calls). On expiry the run child's process group is terminated (SIGTERM → SIGKILL) without a manual Ctrl-C, and the failure footer shows `E_RUN_TIMEOUT`. `0`, empty, or invalid disables it. Docker mode uses `JAIPH_DOCKER_TIMEOUT` instead. |
| `JAIPH_RUNS_DIR` | host, runtime | path | `.jaiph/runs` under the workspace | `run.logs_dir` | Root directory for run logs. Inside Docker the host CLI overrides this to `/jaiph/run`. |
| `JAIPH_RUNS_DIR_LOCKED` | internal | bool | — | — | Lock flag for `JAIPH_RUNS_DIR`. |
| `JAIPH_SCRIPTS` | internal | path | — | — | Directory of emitted `script` files for this run. Set after `buildScripts()`. Any parent-shell value is cleared before launch. |
| `JAIPH_SERVE_EXPOSE_DOCS` | host | bool | `true` | — | `jaiph serve` — expose `GET /docs` (a self-contained Swagger UI whose assets are embedded in the binary, so it needs no browser internet access) and `GET /openapi.json`. Set `false` (or `0`) to return `404` for `/docs`, its embedded assets, and `/openapi.json`, so a hardened deployment hides its API surface. `/healthz` is always available and credential-free. |
| `JAIPH_SERVE_MAX_ARTIFACT_BYTES` | host | int | `0` (no cap) | — | `jaiph serve` — max size (bytes) of one artifact download; a larger file is refused with HTTP `413`. Downloads always stream with backpressure, so `0` (no cap) still keeps server memory bounded regardless of artifact size. Must be `>= 0`. |
| `JAIPH_SERVE_MAX_CONCURRENT` | host | int | `4` | — | `jaiph serve` — cap on simultaneously-running workflows; requests beyond it get HTTP `429`. Must be a positive integer. |
| `JAIPH_SERVE_MAX_OUTPUT_BYTES` | host | int | `1048576` (1 MiB) | — | `jaiph serve` — per-run byte cap applied independently to collected stdout, stderr, log output, and the public `result_text`. Output beyond the cap is dropped with a deterministic truncation marker, bounding one run's memory. Must be a positive integer. |
| `JAIPH_SERVE_OIDC_AUDIENCE` | host | string | — | — | `jaiph serve` — expected JWT `aud` claim for OIDC/JWT auth mode. Set together with `JAIPH_SERVE_OIDC_ISSUER` to enable OIDC (per-user identity + scope authorization); setting only one is a startup error. Takes precedence over `JAIPH_SERVE_TOKEN`. |
| `JAIPH_SERVE_OIDC_ISSUER` | host | string | — | — | `jaiph serve` — expected JWT `iss` claim and (unless `JAIPH_SERVE_OIDC_JWKS_URI` is set) the base for OIDC discovery (`<issuer>/.well-known/openid-configuration`). Enables OIDC/JWT auth mode with `JAIPH_SERVE_OIDC_AUDIENCE`. Tokens are authorized by the `jaiph:invoke` / `jaiph:inspect` / `jaiph:cancel` scopes and may inspect/cancel only their own runs. |
| `JAIPH_SERVE_OIDC_JWKS_URI` | host | string | — | — | `jaiph serve` — explicit JWKS URI for OIDC token verification. Optional; when unset the JWKS URI is discovered from `JAIPH_SERVE_OIDC_ISSUER`'s OpenID configuration document. |
| `JAIPH_SERVE_RETAIN_AGE_SEC` | host | int | `86400` (24h) | — | `jaiph serve` — max age (seconds, from `ended_at`) of a completed run kept in the in-memory registry; older terminal records are evicted. `0` disables age eviction. Active runs are never evicted; durable `.jaiph/runs` artifacts are unaffected. Must be `>= 0`. |
| `JAIPH_SERVE_RETAIN_RUNS` | host | int | `500` | — | `jaiph serve` — max completed runs kept in the in-memory registry; beyond it the oldest terminal records are evicted first. Active runs are never evicted; durable `.jaiph/runs` artifacts are unaffected. Must be a positive integer. |
| `JAIPH_SERVE_TOKEN` | host | string | — | — | `jaiph serve` — static **single-operator** bearer token required on every `/v1/*` and `/mcp` request (constant-time compared). This is a shared-secret gate, **not** multi-tenant authentication: there is no per-user identity, revocation, or per-action authorization — the one operator holds every capability. For those, use OIDC (`JAIPH_SERVE_OIDC_ISSUER` + `JAIPH_SERVE_OIDC_AUDIENCE`), which takes precedence. Unset leaves `/v1/*` open on loopback; binding a non-loopback `--host` with no auth is a startup error. `/healthz` is always unauthenticated; `/docs` + `/openapi.json` follow `JAIPH_SERVE_EXPOSE_DOCS`. The whole `JAIPH_SERVE_*` family is host-only and is excluded from the forwarding allowlist and the prompt scrub, so a workflow the server runs never sees this token. |
| `JAIPH_SITE` | host | string | `https://jaiph.org` | — | Base URL `jaiph use` (and the `docs/run` / `docs/init` bootstraps) fetch the install script and its `install.sha256` from. The default install path verifies the fetched script against the published checksum before executing it (finding M-11). |
| `JAIPH_SKILL_PATH` | host | path | — | — | When set and the path exists, `jaiph init` writes `.jaiph/SKILL.md` from that file. Otherwise the CLI walks an install-relative search. |
| `JAIPH_SOURCE_ABS` | internal | path | — | — | Absolute path to the entry `.jh` file. Set by the CLI before spawning the runner. |
| `JAIPH_SOURCE_FILE` | internal | string (basename) | entry-file basename | — | Used to name run directories. |
| `JAIPH_STDLIB` | host | path | — | — | Removed from the product. Stripped from the launched env. |
| `JAIPH_TELEMETRY_FLUSH_MS` | host | int (ms) | `10000` | — | Total flush budget for the post-run telemetry hook. The OTLP-trace and Sentry exporters run concurrently, each bounded by this, so the whole flush cannot exceed it. A non-positive or unparseable value falls back to the default. Best-effort only — never load-bearing on the run. |
| `JAIPH_TEST_MODE` | runtime | bool (exact `"1"`) | `false` | — | Set by `jaiph test` so the runtime skips production-only branches (e.g. file-mode normalization). |
| `JAIPH_TRUSTED_ENVS` | host | bool (`1` / `true`) | `false` | `trusted_envs` (entry file) | Operator opt-in that lets the **entry file's** `trusted_envs` cross the Docker sandbox allowlist. Absent it, a file-declared `trusted_envs` is ignored under Docker (with a warning) so an untrusted/model-edited entry cannot pull host secrets (e.g. `AWS_SECRET_ACCESS_KEY`) into the sandbox. Authoring the entry file is a trust boundary equal to `--env`. Host modes have no allowlist to bypass, so they honour the declaration regardless. Not itself settable via `--env` / `trusted_envs` (`E_ENV_RESERVED`). |
| `JAIPH_TRUST_PROJECT_HOOKS` | host | bool (`1` / `true`) | `false` | — | Operator opt-in that trusts the current workspace's project-local `.jaiph/hooks.json`. Hook commands run on the **host** CLI — before and outside any Docker sandbox — so absent this opt-in a project-local hooks file is ignored (with a one-line stderr notice) and none of its commands run: a cloned or untrusted repo cannot execute arbitrary host commands on `jaiph run` / `jaiph serve` / `jaiph mcp` (finding M-10). The global `~/.jaiph/hooks.json` is the operator's own and always runs regardless. Read from the host env only; not itself settable via `--env` / `trusted_envs` (`E_ENV_RESERVED`). |
| `JAIPH_UNSAFE` | host | bool (`true` only) | `false` | — | Disable Docker for this run; execute on the host with **no sandbox** (entire filesystem and host environment visible to scripts and agent backends). `--unsafe` is the flag form on `jaiph run`, `jaiph serve`, and `jaiph mcp` (flag wins: it sets this variable for that process). Mutually exclusive with `JAIPH_INPLACE` / `--inplace` (`E_FLAG_CONFLICT`). When this turns Docker off while it would otherwise be on, `jaiph run` requires consent: a TTY warning + `Continue? [y/N]` (default no), or `JAIPH_INPLACE_YES` / `--yes` non-interactively (else `E_UNSAFE_NO_CONFIRM`). `jaiph serve` / `jaiph mcp` never prompt, but they still require **explicit** consent on the server's own command line — `--unsafe` (or `--yes`). An ambient `JAIPH_UNSAFE=true` inherited from the environment **without** that flag is refused at startup (`E_UNSAFE_NO_CONSENT`), so a value left over in a shell profile cannot silently switch a server to host-only. When consent is given, the effective posture is printed once at startup as a prominent multi-line banner and applied to every call. No prompt/refusal when Docker is off for another reason (explicit `JAIPH_DOCKER_ENABLED=false`, Windows host-only override) or on `jaiph run --raw`. The `ghcr.io/jaiphlang/jaiph-runtime` image **bakes `JAIPH_UNSAFE=true`** so it can run standalone (`docker run … jaiph run flow.jh`, or as a k8s pod) — inside the image the container is the sandbox, so host-only proceeds without the flag (server modes skip the refusal in-container); see [Deploy](deploy.md). |
| `JAIPH_WORKSPACE` | host, runtime | path | autodetected | — | Workspace root. Inside Docker the host CLI overrides this to `/jaiph/workspace`. |

<!-- end: src-parity -->

### Internal Docker-only variables

The host CLI sets two more variables on the Docker container that are not in the table above. The source-parity harness tracks only names read through a literal `env.JAIPH_*` or `process.env["JAIPH_*"]` access in `src/`, and both of these are read through a computed key instead, so they escape that pattern. The CLI manages both of them, so never export them by hand.

| Variable | Scope | Role |
|---|---|---|
| `JAIPH_RUN_WORKFLOW` | internal | Root workflow symbol the inner `jaiph run --raw` executes. Set as `-e` only for a non-`default` root (for example an MCP tool call); read back in the container by `runWorkflowRaw` through a computed key. Reserved from `--env` (`E_ENV_RESERVED`). |
| `JAIPH_DOCKER_SANDBOX` | internal | Marks the inner `jaiph run --raw` as the host-orchestrated sandbox run so it does **not** re-export telemetry — the outer host process exports that run exactly once. Always set as `-e` on the container. Covered by the `JAIPH_DOCKER_*` reservation (`E_ENV_RESERVED`) and never auto-forwarded from the host env. |

## Agent credentials

The host CLI checks these before spawning the runner or container when [credential pre-flight](configuration.md#credential-pre-flight) applies. Pre-flight is skipped when the entry file declares no explicit backend and uses no `prompt` step, on `jaiph run --raw`, and when `JAIPH_UNSAFE=true`. See [Authenticate agent backends](agent-auth.md) for per-backend rules and [Sandboxing](sandboxing.md) for which credentials cross the container boundary.

| Variable | Backend | Host behaviour | Docker behaviour | Notes |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | `claude` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | Either this **or** `CLAUDE_CODE_OAUTH_TOKEN` satisfies Claude. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | Long-lived OAuth token from `claude setup-token`. |
| `CURSOR_API_KEY` | `cursor` | warning if absent | hard error (`E_AGENT_CREDENTIALS`) | A stored `cursor-agent login` may still work on host runs. |
| `OPENAI_API_KEY` | `codex` | hard error (`E_AGENT_CREDENTIALS`) | hard error (`E_AGENT_CREDENTIALS`) | No CLI-login fallback. Forwarded into the Docker container when the entry file selects `codex` — set on the host before `jaiph run`. |

Jaiph forwards a fixed allowlist into the Docker container. The allowlist is the `JAIPH_*` run-control keys, except `JAIPH_DOCKER_*`, `JAIPH_SERVE_*`, `JAIPH_INPLACE`, and `JAIPH_INPLACE_YES`, plus the credential keys of the backends the entry file selects. The credential keys are `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` for `claude`, `CURSOR_API_KEY` for `cursor`, and `OPENAI_API_KEY` for `codex`. Jaiph silently drops every other variable, including other variables in those families (for example `ANTHROPIC_BASE_URL` or `CLAUDE_CONFIG_DIR`) and unrelated cloud credentials. To forward one on purpose, use the `--env` flag described below. See [Sandboxing](sandboxing.md).

To forward a variable outside the allowlist, for example `GITHUB_TOKEN` or `AWS_ACCESS_KEY_ID`, into a single run, use the per-key `--env` flag on `jaiph run`, `jaiph serve`, or `jaiph mcp`. `--env KEY=VALUE` sets an exact value, and `--env KEY` forwards the host's current value. In host mode `--env` defines the variable on the workflow process directly. In a Docker sandbox it crosses the boundary unchanged as an explicit `-e KEY=VALUE` container argument, so it bypasses the allowlist above, and the flag is the per-key consent for that. An `--env` value wins over any allowlist-forwarded value for the same key.

Jaiph rejects some names before it spawns anything. A bare `--env KEY` that is unset on the host aborts with `E_ENV_MISSING`. An invalid name gives `E_ENV_INVALID`. The sandbox-control and runtime-managed keys the CLI owns (`JAIPH_UNSAFE`, `JAIPH_INPLACE`, `JAIPH_INPLACE_YES`, any `JAIPH_DOCKER_*`, `JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, `JAIPH_RUN_ID`, `JAIPH_SCRIPTS`, `JAIPH_MODULE_GRAPH_FILE`, `JAIPH_SOURCE_ABS`, `JAIPH_META_FILE`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_RUN_WORKFLOW`) are rejected with `E_ENV_RESERVED`, so use the sandbox flags or real environment variables for those. Values are never path-remapped. See [CLI — `jaiph run` flags](cli.md#jaiph-run).

A variable forwarded with `--env` is visible to trusted `run` script and workflow steps, but not to `prompt` agent subprocesses. Jaiph spawns every prompt backend with a fail-closed scrub of the environment. The scrub forwards only the base environment (`PATH`, `HOME`, locale, proxies, `CLAUDE_CONFIG_DIR`, and so on), the `JAIPH_*` control keys, and that backend's own credential keys. The scrub works the same way in host mode and in every Docker sandbox mode. See [Sandboxing — environment exposure](sandboxing.md#env-exposure).

For the common case of forwarding a host key, the [`trusted_envs`](configuration.md#trusted-envs) config key is the in-file alternative to `--env`. A `.jh` file names the host keys its trusted `run` steps need, for example `trusted_envs = "GITHUB_TOKEN"`. The keys resolve from a clean snapshot of the host environment, and the same reserved-key (`E_ENV_RESERVED`) and missing-value (`E_ENV_MISSING`) rules apply. An explicit `--env KEY=VALUE` still overrides the snapshot value for that key. Like `--env`, `trusted_envs` values reach trusted `run` steps only, never `prompt` subprocesses. Under Docker, the entry file's `trusted_envs` is honored only when the operator opts in with `JAIPH_TRUSTED_ENVS=1` (see the table above) — authoring the entry file is a trust boundary equal to `--env`, so the operator, not the file, consents to which host secrets cross the sandbox allowlist (finding M-7).

## Telemetry variables

Jaiph reads the standard OpenTelemetry environment variables to export one trace
per run to an OTLP collector. Only the `OTEL_*` and `SENTRY_*` variables turn
export on, not any `JAIPH_*` variable. Jaiph reads them on the host after the run
completes and never forwards them into the Docker sandbox, so the `JAIPH_*`
source-parity harness above does not track them. Export is enabled only when a
traces endpoint is set. The one variable Jaiph owns here is the shared flush
budget `JAIPH_TELEMETRY_FLUSH_MS`, listed in the source-parity table above, which
bounds delivery but never enables it. See
[Export traces to an OTLP collector](observability.md).

| Variable | Type | Default | Role |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | string (URL) | — | Traces endpoint, used verbatim. Enables export. Wins over the generic endpoint when both are set. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string (URL) | — | Generic OTLP base URL; `/v1/traces` is appended. Enables export when the traces-specific one is unset. |
| `OTEL_EXPORTER_OTLP_HEADERS` | string (`k=v,k=v`) | — | Comma-separated headers applied to the export POST (for example an auth token). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | string (`http/json`) | `http/json` | Only `http/json` is spoken. Any other value (for example `grpc`) → warn on stderr and skip export. |
| `OTEL_SERVICE_NAME` | string | `jaiph` | `service.name` resource attribute on every exported span. |
| `OTEL_RESOURCE_ATTRIBUTES` | string (`k=v,k=v`) | — | Extra resource attributes. Jaiph also always adds `jaiph.version`, `jaiph.run_id`, `jaiph.workflow`, and `jaiph.source`; an authenticated `jaiph serve` run additionally adds `jaiph.principal` (audit subject) and `jaiph.correlation_id` (request id) — never a token or a secret-bearing claim. |

Jaiph also reads the standard Sentry environment variables to report failed
runs to a Sentry error tracker. As with the OpenTelemetry variables, no `JAIPH_*`
variable turns the reporting on. Jaiph reads them on the host after the run
completes and never forwards them into the Docker sandbox, so the `JAIPH_*`
source-parity harness above does not track them. Jaiph sends a report only when
`SENTRY_DSN` is set and the run ended unsuccessfully, from a nonzero exit or a
signal. A successful run sends nothing. See [Observability](observability.md#report-failed-runs-to-sentry).

| Variable | Type | Default | Role |
|---|---|---|---|
| `SENTRY_DSN` | string (DSN) | — | Sentry DSN `https://<key>@<host>/<projectId>`. Enables failed-run reporting. A malformed DSN → one stderr warning and no send. |
| `SENTRY_ENVIRONMENT` | string | — | Sets the event's `environment` when present (for example `prod`, `ci`). |
| `SENTRY_RELEASE` | string | `jaiph@<version>` | Sets the event's `release`. |

## Installer and `jaiph use`

The installer shell script (`docs/install`) reads these variables, and `jaiph use` reads them too when it re-invokes the installer. Jaiph does not read them from inside its TypeScript source.

| Variable | Type | Default | Role |
|---|---|---|---|
| `JAIPH_REPO_REF` | string | `v0.12.0` (installer default when unset) | Release ref the installer downloads (`v0.12.0`, `nightly`, …). `jaiph use <version>` sets this to `v<version>` or `nightly`. |
| `JAIPH_BIN_DIR` | path | `$HOME/.local/bin` | Target bin directory for the installed `jaiph` binary. |
| `JAIPH_RELEASE_BASE_URL` | string | `https://github.com/jaiphlang/jaiph/releases/download/<ref>` | Override the GitHub Release base URL the installer downloads from. |
| `JAIPH_MINISIGN_PUBLIC_KEY` | string | bundled release key | minisign public key used to verify `SHA256SUMS.minisig`. Unset uses the bundled key. An explicitly empty value fails closed (the installer refuses to install rather than skipping signature verification). |
| `JAIPH_ALLOW_UNSIGNED` | bool (`1`) | — | Opt in to a checksum-only install when `minisign` cannot verify the release signature (tool missing). Set it and the installer proceeds on checksum only with a prominent warning. Unset, a missing `minisign` aborts the install on **every** host, CI included — `CI` is no longer a checksum-only opt-out (finding M-5), so CI that needs signed installs must make `minisign` available (the `setup-jaiph` action installs it). A missing `SHA256SUMS.minisig` always aborts regardless of this flag. |
| `JAIPH_REPO_URL` | path | — | Local repo path (directory containing `package.json`) for the from-source installer branch (`docs/install-from-local.sh`). Ignored on the binary-download path. |

## Docker sandbox failure modes

The error codes below surface during Docker-backed `jaiph run` invocations. Jaiph writes them to stderr and to the failure footer, and they produce non-zero exit codes. Most start with `E_DOCKER_`. The codes `E_TIMEOUT`, `E_VALIDATE_MOUNT`, and `E_FLAG_CONFLICT` also appear in Docker contexts, but they are not strictly Docker-scoped.

| Code | Trigger | Behaviour |
|---|---|---|
| `E_DOCKER_NOT_FOUND` | `docker info` fails (Docker not installed or daemon not running). | Run exits before launch. No fallback to local execution. Not reachable on Windows, where the CLI resolves to host-only mode without probing `docker`. |
| `E_DOCKER_PULL` | `docker pull` fails (network error, image not found, auth failure). | Run exits before launch. |
| `E_DOCKER_NO_JAIPH` | Selected image does not contain a `jaiph` CLI. | Run exits before launch. |
| `E_DOCKER_IMAGE_HOST_ONLY` | Entry file declares `runtime.docker_image` while Docker is the active sandbox and no `JAIPH_DOCKER_IMAGE` was set. The image is host-controlled. | Run exits before launch. |
| `E_DOCKER_NETWORK_HOST_ONLY` | Entry file declares an isolation-breaking `runtime.docker_network` (`host`, `container:*`, `ns:*`) while Docker is the active sandbox and no `JAIPH_DOCKER_NETWORK` was set. | Run exits before launch. |
| `E_DOCKER_RUNS_DIR` | Absolute `JAIPH_RUNS_DIR` points outside the workspace. | Run exits before launch. |
| `E_DOCKER_TIMEOUT` | `JAIPH_DOCKER_TIMEOUT` is empty, non-numeric, negative, or has trailing junk; or `runtime.docker_timeout_seconds` is negative. | Run exits before launch. |
| `E_DOCKER_DIGEST` | `JAIPH_DOCKER_IMAGE_DIGEST` is not a `sha256:<64 hex>` (or bare 64-hex) digest. | Run exits before launch. |
| `E_DOCKER_DIGEST_MISMATCH` | The resolved local sandbox image's registry digest does not match the pinned digest (a re-pointed tag, a poisoned local cache, or an image never pulled from a registry). | Run exits before launch; re-pull the pinned image to recover. |
| `E_DOCKER_UID` | Linux host UID/GID detection failed. | Run exits before launch. |
| `E_DOCKER_SANDBOX_COPY` | Snapshot mode failed to clone the host workspace. | Run exits before launch. |
| `E_DOCKER_INPLACE_NO_CONFIRM` | `JAIPH_INPLACE` is set but stdin is not a TTY and `JAIPH_INPLACE_YES` is not set. | Run exits before launch. |
| `E_UNSAFE_NO_CONFIRM` | Unsafe host-only run (`JAIPH_UNSAFE=true` / `--unsafe`, Docker otherwise on) but stdin is not a TTY and `JAIPH_INPLACE_YES` is not set. | Run exits before launch. |
| `E_UNSAFE_NO_CONSENT` | `jaiph serve` / `jaiph mcp` would go host-only from an inherited `JAIPH_UNSAFE=true` with no explicit `--unsafe` / `--yes` on the command line (and not inside a container). | Server exits before serving. |
| `E_FLAG_CONFLICT` | `--inplace` / `JAIPH_INPLACE` and `--unsafe` / `JAIPH_UNSAFE=true` are both set. | Run exits before launch. |
| `E_VALIDATE_MOUNT` | Mount targets a denied host path (`/`, `/proc`, docker socket, etc.). | Run exits before launch. |
| `E_TIMEOUT` | Container runs longer than the effective Docker timeout. | The container is force-removed by name (`docker rm -f`) so it cannot outlive its client, then the host `docker` process tree receives SIGTERM, then SIGKILL after 5s grace. |
| `E_AGENT_CREDENTIALS` | Credential pre-flight detected a missing agent credential. | Run exits before launch. |

## Related

- [Configuration](configuration.md) — config keys and their environment-variable equivalents.
- [CLI](cli.md) — commands and flags that front-end these variables.
- [Sandboxing](sandboxing.md) — what the Docker sandbox protects and what it does not.
