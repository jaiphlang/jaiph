---
title: Authenticate agent backends
permalink: /how-to/agent-auth
diataxis: how-to
---

# Authenticate agent backends

This guide sets the credentials each agent backend needs, so the CLI's credential pre-flight passes and `prompt` steps can reach the model. `jaiph run` runs a host-side pre-flight before it spawns the runner: a missing `codex` credential is a hard failure (`E_AGENT_CREDENTIALS`) that stops the run, a missing `cursor` credential only warns, and `claude` is not checked. The full pre-flight scope-and-dedup rules live in [Configuration — Credential pre-flight](configuration.md#credential-pre-flight), and the credential names live in [Environment variables — Agent credentials](env-vars.md#agent-credentials).

## Prerequisites

- The entry `.jh` file declares a backend in a `config { }` block (`agent.backend = "claude" | "cursor" | "codex"`) or uses a `prompt` step that consumes the default backend.

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

A stored `~/.claude` or macOS Keychain login from a previous interactive `claude` session also works. Claude credentials are not checked by the pre-flight.

## 2. Authenticate Cursor

```bash
export CURSOR_API_KEY="..."
```

For host runs, an interactive `cursor-agent login` (stored on disk) also satisfies the runtime, but the pre-flight warns unless `CURSOR_API_KEY` is set.

## 3. Authenticate Codex (OpenAI)

```bash
export OPENAI_API_KEY="sk-..."
```

`OPENAI_API_KEY` is required; the `codex` backend has no CLI-login fallback, so there is no warning path. To target an OpenAI-compatible endpoint, set `JAIPH_CODEX_API_URL` to the chat-completions URL.

## 4. Run the pre-flight

```bash
jaiph run ./flow.jh
```

The pre-flight runs before the banner. A hard failure (`codex` only) prints a stderr message prefixed with `E_AGENT_CREDENTIALS`, naming the backend, the model when set, the entry file, the config scope that picked the backend, and the remedy. The `cursor` warning uses the same fields with a `jaiph: warning:` prefix; `claude` prints neither. `jaiph run --raw`, and a file that neither declares a backend nor uses a `prompt` step, skip the pre-flight entirely. `jaiph serve` and `jaiph mcp` run the same pre-flight once at startup but print every result — including the `codex` case — as a warning, so a server can start before its credentials are set.

## Verification

When every required credential is present, the pre-flight is silent, with no stderr before the banner. A missing `cursor` env var emits a warning and the run still proceeds:

```
jaiph: warning: agent.backend "cursor" selected by module config in /path/to/flow.jh — CURSOR_API_KEY is not set. Set CURSOR_API_KEY (or run `cursor-agent login`). A stored cursor-agent login may still work.
```

Only `codex` hard-fails. When `OPENAI_API_KEY` is missing, the pre-flight prints this and the command stops before the banner:

```
E_AGENT_CREDENTIALS: agent.backend "codex" selected by module config in /path/to/flow.jh — OPENAI_API_KEY is not set. Set OPENAI_API_KEY to your OpenAI API key.
```

## Related

- [Configure backend/model](configure-backend.md) — picking which backend a def uses.
- [Pass a host key to a script](script-env.md) — `use` + `--env` for script and named-prompt secrets.
- [Environment variables](env-vars.md) — `--env` and credential names.
