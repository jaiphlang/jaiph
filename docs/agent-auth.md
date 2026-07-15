---
title: Authenticate agent backends
permalink: /how-to/agent-auth
diataxis: how-to
---

# Authenticate agent backends

This recipe sets the credentials each agent backend needs so the CLI's credential pre-flight passes and `prompt` steps reach the model.

`jaiph run` runs a host-side **credential pre-flight** before it spawns the runner or the Docker container. The pre-flight is keyed to the backend(s) declared in the entry file. Missing credentials produce `E_AGENT_CREDENTIALS` (hard abort) or a `jaiph: warning:` (host-only, for `claude` and `cursor` — see the table below). Hard failures exit before any runner or container is launched. The behavior is implemented in `src/cli/run/preflight-credentials.ts`.

## Prerequisites

- The entry `.jh` file declares a backend (`agent.backend = "claude" | "cursor" | "codex"`) at module or workflow scope, or uses a `prompt` step that consumes the default backend.

## Pick the backend's credential

| Backend | Required credentials | Host run (no Docker) | Docker run (any mode incl. `inplace`) |
|---|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` | warn only (a stored Claude CLI login may still work) | hard error `E_AGENT_CREDENTIALS` |
| `cursor` | `CURSOR_API_KEY` | warn only (a stored `cursor-agent login` may still work) | hard error `E_AGENT_CREDENTIALS` |
| `codex`  | `OPENAI_API_KEY` | hard error `E_AGENT_CREDENTIALS` (no CLI-login fallback) | hard error `E_AGENT_CREDENTIALS` — `OPENAI_*` is **not** on the Docker env allowlist, so a host-only key is treated as missing |

Under Docker sandboxing the host-side stored logins (Keychain entries, `~/.claude`, `cursor-agent login`) do **not** cross the container boundary. Only allowlisted host env vars are forwarded (`JAIPH_*`, `ANTHROPIC_*`, `CLAUDE_*`, `CURSOR_*`; see [Sandboxing](sandboxing.md#what-docker-protects-against)). Set credentials on the **host** so the allowlist can forward them into the container.

## 1. Authenticate Claude

Either set the API key directly:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or obtain a long-lived OAuth token through the Claude CLI:

```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN="..."
```

On host runs (no Docker), a stored `~/.claude` / macOS Keychain login from a previous interactive `claude` session also works — but in that case the pre-flight emits a warning rather than failing.

## 2. Authenticate Cursor

```bash
export CURSOR_API_KEY="..."
```

For host runs only, an interactive `cursor-agent login` (stored on disk) also satisfies the runtime — but the pre-flight emits a warning unless the env var is set.

## 3. Authenticate Codex (OpenAI)

```bash
export OPENAI_API_KEY="sk-..."
```

`OPENAI_API_KEY` is required on **both** host and Docker runs. The `codex` backend has no CLI-login fallback — there is no warning path.

Under Docker, `OPENAI_*` is outside the forwarding allowlist, so preflight treats a host-only `OPENAI_API_KEY` as missing even when you export it. Codex workflows need `jaiph run --unsafe` (host execution) or a different backend inside the sandbox.

To target an OpenAI-compatible endpoint instead of the default, set `JAIPH_CODEX_API_URL` to the chat-completions URL (`JAIPH_*` is forwarded under Docker).

## 4. Run the pre-flight

```bash
jaiph run ./flow.jh
```

The pre-flight runs before the banner. Hard failures print a stderr message naming the backend, the model (when `agent.model` is set), the entry `.jh` file, the config scope that picked the backend (`module config`, `workflow <name>`, `JAIPH_AGENT_BACKEND env`, or `default`), and the concrete remedy. The error code is `E_AGENT_CREDENTIALS`. Host-only warnings for `claude` and `cursor` use the same header fields with a `jaiph: warning:` prefix.

## Skip the pre-flight (escape hatch)

`JAIPH_UNSAFE=true` (or `jaiph run --unsafe`) skips the pre-flight entirely — the host is in charge, a stored CLI login may work, and the runtime's per-backend guards remain as a backstop. The pre-flight is also skipped when the entry file neither declares an explicit backend nor uses any `prompt` step (nothing would credential against).

## Verification

When every required credential is present, preflight is silent — no stderr before the banner. On host runs, missing `claude` or `cursor` env vars emit `jaiph: warning:` lines and the run still proceeds (a stored CLI login may satisfy the runtime). A hard failure prints:

```
E_AGENT_CREDENTIALS: agent.backend "claude" selected by module config in /path/to/flow.jh — neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or set ANTHROPIC_API_KEY.
```

Under Docker the message includes the suffix `(Docker is on — set the env var on the host so it is forwarded into the container.)`.

## Related

- [Run a workflow in a Docker sandbox](/how-to/sandbox-run) — how host env vars cross the container boundary.
- [Configure backend/model](/how-to/configure-backend) — picking which backend a workflow uses.
- [Sandboxing — What Docker protects against](sandboxing.md#what-docker-protects-against) — env allowlist and what crosses the container boundary.
