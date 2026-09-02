---
title: Authenticate agent backends
permalink: /how-to/agent-auth
diataxis: how-to
---

# Authenticate agent backends

This guide shows how to set the credentials each agent backend needs, so the CLI's credential pre-flight passes and `prompt` steps can reach the model.

`jaiph run` runs a host-side credential pre-flight before it spawns the runner. The pre-flight checks the backends the entry file declares. Missing credentials produce one of two results. A missing `codex` credential is a hard failure with the error `E_AGENT_CREDENTIALS`, and the run stops before any runner is launched. A missing `claude` or `cursor` credential produces only a `jaiph: warning:` line and the run still proceeds (see the table below). The behavior is implemented in `src/cli/run/preflight-credentials.ts`.

## Prerequisites

- The entry `.jh` file declares a backend in a `config { }` block (`agent.backend = "claude" | "cursor" | "codex"`) at module or def scope, or uses a `prompt` step that consumes the default backend.

## Pick the backend's credential

| Backend | Required credentials | Host behaviour |
|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | warn only (a stored Claude CLI login may still work) |
| `cursor` | `CURSOR_API_KEY` | warn only (a stored `cursor-agent login` may still work) |
| `codex`  | `OPENAI_API_KEY` | hard error `E_AGENT_CREDENTIALS` (no CLI-login fallback) |

Set credentials on the host. Forward anything else one key at a time with `--env`.

### Which backends get checked

The pre-flight validates every backend the entry file could reach, which is each backend the entry file declares plus the effective default backend. The default is `cursor` unless `JAIPH_AGENT_BACKEND` overrides it, and it is always included because `prompt` steps that name no backend fall back to it. Each backend is checked independently, so a file that reaches more than one backend can emit more than one warning or error in a single pre-flight.

The default is deduplicated against your declarations, so where you set the backend decides whether the `cursor` default is also checked:

- **Module scope.** Putting `config { agent.backend = "claude" }` at the top of the file makes `claude` the effective default, so only `claude` is checked.
- **Def scope only.** Putting `config { agent.backend = "claude" }` inside a def, with no module-level backend, leaves `cursor` as the default. The pre-flight then checks both `claude` and `cursor`.

To check only the backend you intend to use, set it at module scope or export `JAIPH_AGENT_BACKEND`. Either one becomes the default and absorbs the extra check. See [Configure backend/model](configure-backend.md) for the config scopes.

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

A stored `~/.claude` or macOS Keychain login from a previous interactive `claude` session also works, but in that case the pre-flight emits a warning rather than failing.

## 2. Authenticate Cursor

```bash
export CURSOR_API_KEY="..."
```

For host runs only, an interactive `cursor-agent login` (stored on disk) also satisfies the runtime, but the pre-flight emits a warning unless the env var is set.

## 3. Authenticate Codex (OpenAI)

```bash
export OPENAI_API_KEY="sk-..."
```

`OPENAI_API_KEY` is required. The `codex` backend has no CLI-login fallback, so there is no warning path.

To target an OpenAI-compatible endpoint instead of the default, set `JAIPH_CODEX_API_URL` to the chat-completions URL.

## 4. Run the pre-flight

```bash
jaiph run ./flow.jh
```

The pre-flight runs before the banner. A hard failure (`codex` only) prints a stderr message naming the backend, the model (when `agent.model` is set), the entry `.jh` file, the config scope that picked the backend (`module config`, `def <name>`, `JAIPH_AGENT_BACKEND env`, or `default`), and the remedy. The message is prefixed with `E_AGENT_CREDENTIALS`. Host-only warnings for `claude` and `cursor` use the same header fields with a `jaiph: warning:` prefix.

## Skip the pre-flight

The pre-flight is skipped when the entry file neither declares an explicit backend nor uses any `prompt` step, because nothing would credential against.

`jaiph run --raw` also skips the pre-flight.

## Verification

When every required credential is present, the pre-flight is silent, with no stderr before the banner. On host runs, missing `claude` or `cursor` env vars emit `jaiph: warning:` lines and the run still proceeds, because a stored CLI login may satisfy the runtime. A missing `claude` credential prints this warning:

```
jaiph: warning: agent.backend "claude" selected by module config in /path/to/flow.jh — neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or set ANTHROPIC_API_KEY. A stored Claude CLI login may still work.
```

Only the `codex` backend hard-fails. When `OPENAI_API_KEY` is missing, the pre-flight prints this and the command stops before the banner:

```
E_AGENT_CREDENTIALS: agent.backend "codex" selected by module config in /path/to/flow.jh — OPENAI_API_KEY is not set. Set OPENAI_API_KEY to your OpenAI API key.
```

## Related

- [Configure backend/model](configure-backend.md) — picking which backend a def uses.
- [Pass a host key to a script](script-env.md) — `use` + `--env` for script and named-prompt secrets.
- [Environment variables](env-vars.md) — `--env` and credential names.
