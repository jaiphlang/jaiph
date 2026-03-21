---
title: Configuration
permalink: /configuration
redirect_from:
  - /configuration.md
---

# Jaiph Configuration

Configuration controls how the Jaiph runtime behaves: which agent runs `prompt` steps, where step logs are stored, and whether shell trace (debug) is enabled. There are two sources of configuration:

1. **In-file config** — a `config { ... }` block in the workflow file you pass to `jaiph run`.
2. **Environment variables** — `JAIPH_AGENT_*` and `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`.

Environment overrides in-file; in-file overrides built-in defaults. So: env wins, then in-file, then defaults.

## In-file config

In the entry workflow file (the one you pass to `jaiph run`), you can declare runtime options in a single **config block**. The block is optional. If present, it must start with exactly `config {` on its own line. You can place it at top level anywhere before any rule, function, or workflow (e.g. after a shebang or imports). Only one config block per file; a second one causes a parse error (`E_PARSE` with file location). An unknown config key also yields `E_PARSE`; the error message lists the allowed keys.

Inside the block, use `key = value` lines. Empty lines and lines starting with `#` are ignored. Values can be:

- **Quoted strings** — double or single quotes. Escape sequences: `\\`, `\n`, `\t`, `\"`.
- **Booleans** — `true` or `false` (unquoted).
- **Integers** — bare numeric literals (e.g. `300`). No floats, negatives, or hex.
- **Arrays of strings** — bracket-delimited, e.g. `["a", "b"]`. Opening `[` must be on the same line as `=`. Each element is a quoted string on its own line. Trailing commas and `#` comments between elements are allowed. Empty array `= []` is valid.

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

Allowed config keys:

**Agent keys:**

- `agent.default_model`: Default model for `prompt` steps (string).
- `agent.command`: Command string for the **cursor** backend (string, e.g. `cursor-agent` or `cursor-agent --force`).
- `agent.backend`: Which prompt backend to use: `"cursor"` (default) or `"claude"`. When `"claude"`, the **Claude CLI** (`claude`) is invoked; it must be on PATH. See [Backend selection](#backend-selection) below.
- `agent.trusted_workspace`: Trusted workspace directory passed to the Cursor backend (`--trust`). When set in-file, relative paths are resolved from the workspace (project) root. When set via environment, the value is used as-is. Defaults to the project root when unset.
- `agent.cursor_flags`: Extra flags appended to Cursor backend invocation (string; split on whitespace).
- `agent.claude_flags`: Extra flags appended to Claude backend invocation (string; split on whitespace).

**Run keys:**

- `run.logs_dir`: Directory for step logs. Relative paths are resolved against the workspace root at runtime; absolute paths are used as-is (string).
- `run.debug`: If `true`, enables Bash `set -x` (shell trace) for the run (boolean).

**Runtime keys (Docker sandbox):**

- `runtime.docker_enabled`: Enable Docker sandbox for the run (boolean, default `true` locally, `false` in CI).
- `runtime.docker_image`: Container image to use (string, default `"ubuntu:24.04"`).
- `runtime.docker_network`: Docker network mode (string, default `"default"`).
- `runtime.docker_timeout`: Maximum execution time in seconds (integer, default `300`).
- `runtime.workspace`: Mount specifications (string array, default `[".:/jaiph/workspace:rw"]`).

Each key enforces its expected type: assigning a string to an integer key, or a boolean to a string key, etc., produces `E_VALIDATE`. Unknown `runtime.*` keys produce `E_PARSE`.

### Mount parsing rules

Mount strings in `runtime.workspace` follow these forms:

- **Full form** (3 segments): `"host_path:container_path:mode"` — mounts `host_path` at `container_path` with mode `ro` or `rw`.
- **Shorthand** (2 segments): `"host_path:mode"` — mounts at `/jaiph/workspace/<host_path>` with the given mode.
- **1 segment** → `E_PARSE` (invalid).
- Mode must be `ro` or `rw` → `E_PARSE` otherwise.
- Exactly one mount must target `/jaiph/workspace` (validated before Docker invocation). If `runtime.workspace` is omitted, the default `[".:/jaiph/workspace:rw"]` satisfies this.

### Workspace structure inside the container

```
/jaiph/
  generated/          # transpiled bash + jaiph_stdlib.sh, mounted read-only
  workspace/          # the mount targeting /jaiph/workspace (read-write root)
    .jaiph/
      runs/
        <YYYY-MM-DD>/
          <HH-MM-SS>-<source-file>/
            000001-<module>__<step>.out
            000002-<module>__<step>.out
            ...
```

- `/jaiph/generated/` contains the transpiled `.sh` script and `jaiph_stdlib.sh`. Both mounted read-only. `JAIPH_STDLIB` is set to `/jaiph/generated/jaiph_stdlib.sh` inside the container.
- Container receives **only** transpiled bash and the shell stdlib. No Jaiph source files, no TypeScript, no Node.js.

### Docker behavior

- `docker run --rm` with proper UID/GID mapping (`--user $(id -u):$(id -g)` on Linux).
- TTY passthrough: `-t` flag when `process.stdout.isTTY` is true. Because Docker with `-t` merges the container's stderr into stdout, the CLI buffers Docker stdout line-by-line and filters out `__JAIPH_EVENT__` lines (routing them through the event handler instead). This ensures the progress tree output is identical whether Docker is enabled or not.
- Step output reporting: the bash stdlib always embeds `out_content` in `STEP_END` events (and `err_content` for failed steps), regardless of dispatch status. The CLI uses this embedded content exclusively for display — it never reads `out_file`/`err_file` from disk for rendering. This makes step output identical in Docker and non-Docker modes. Embedded content is capped at 1 MB; larger output is truncated with a `[truncated]` marker. The full output remains in `out_file`/`err_file` on disk for debugging and archival.
- Docker TTY stream merging: Docker with `-t` merges the container's stderr into stdout. The CLI demuxes event lines from user output via line-based buffering. Ordering and timing of interleaved stdout/stderr may still differ from non-Docker mode — this is a known limitation.
- Docker is **enabled by default** on local machines. `CI=true` disables Docker by default (many CI runners lack Docker-in-Docker). In-file `runtime.docker_enabled = true` or `JAIPH_DOCKER_ENABLED=true` overrides this in either environment.
- Docker missing → `E_DOCKER_NOT_FOUND` (no silent fallback).
- Image auto-pulled if missing; pull failure is fatal.
- Timeout kills container and reports `E_TIMEOUT`.
- Network: `"default"` omits `--network` flag (uses Docker bridge). `"none"` passes `--network none`. Any other value is passed verbatim.

### Dockerfile-based image detection

When no explicit `docker_image` is configured (neither `JAIPH_DOCKER_IMAGE` env var nor in-file `runtime.docker_image`), the runtime checks for `.jaiph/Dockerfile` in the workspace root. If present:

1. The runtime runs `docker build` from that Dockerfile and tags the result as `jaiph-runtime:latest`.
2. The built image is used for the run instead of the default `ubuntu:24.04`.

If `.jaiph/Dockerfile` does not exist, the runtime falls back to the default image (`ubuntu:24.04`). When an explicit image is configured, the Dockerfile is ignored entirely.

The shipped `.jaiph/Dockerfile` includes:

- **Base image**: `ubuntu:latest`
- **Node.js** latest LTS (required by `jaiph::stream_json_to_text` in `prompt.sh`)
- **Claude Code CLI** (`@anthropic-ai/claude-code`)
- **cursor-agent** (Cursor's agent backend)
- Standard utilities: `bash`, `curl`, `git`, `ca-certificates`

### Agent environment variable forwarding

In addition to `JAIPH_*` variables, the following environment variables are forwarded into the Docker container for agent authentication:

- `CURSOR_*` — all environment variables matching the `CURSOR_` prefix (e.g. `CURSOR_SESSION`, `CURSOR_API_KEY`) are forwarded for Cursor agent authentication.
- `ANTHROPIC_*` — all environment variables matching the `ANTHROPIC_` prefix (e.g. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`) are forwarded for Claude authentication/config.
- `CLAUDE_*` — all environment variables matching the `CLAUDE_` prefix are forwarded for Claude CLI authentication/config.

### Docker path remapping

When Docker mode is enabled, the CLI remaps workspace-related environment variables before forwarding them into the container. This ensures that run artifacts are written to paths visible on the host (via the workspace mount) rather than to host-only absolute paths that exist only outside the container.

- `JAIPH_WORKSPACE` is always set to `/jaiph/workspace` inside the container, regardless of the host value.
- `JAIPH_RUNS_DIR` handling depends on the value:
  - **Relative path** (e.g. `custom_runs`) — passed through unchanged. Resolved relative to `/jaiph/workspace` inside the container, which maps back to the host workspace via the mount.
  - **Absolute path inside the host workspace** (e.g. `/home/user/project/.jaiph/runs`) — remapped to the equivalent container path (e.g. `/jaiph/workspace/.jaiph/runs`).
  - **Absolute path outside the host workspace** (e.g. `/var/log/jaiph-runs`) — the run fails immediately with `E_DOCKER_RUNS_DIR`. There is no general way to map an arbitrary host path into the container; use a relative path or a path inside the workspace instead.

This remapping is transparent — you configure `JAIPH_RUNS_DIR` exactly as you would for a non-Docker run and the CLI handles the translation.

### Docker environment variable mapping

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are not overridable via env.

Precedence: env vars (`JAIPH_DOCKER_*`) > in-file config > defaults.

## Backend selection

`prompt` steps can use either the **cursor** backend (default) or the **Claude CLI** backend.

- **cursor** (default): Runs the executable from `agent.command` (default `cursor-agent`) with stream-json output. Use this when you run workflows with Cursor’s agent.
- **claude**: Runs the Anthropic **Claude CLI** (`claude`). Use this when you want the same workflow to drive Claude from the terminal. The `claude` binary must be installed and on your PATH. If you set `agent.backend = "claude"` and `claude` is not found, Jaiph prints a clear error and exits.
- Backend-specific flags are appended from `agent.cursor_flags` / `agent.claude_flags` (or env vars below).

No prompt-level backend override exists; the backend is fixed per run by file config and environment. In `jaiph test`, prompt mocks override backend execution; when a prompt is not mocked, the selected backend runs normally (including Claude CLI if `agent.backend = "claude"`).

## Defaults and precedence

Built-in defaults:

- `agent.default_model`: unset (only passed when configured)
- `agent.command`: `cursor-agent`
- `agent.backend`: `cursor`
- `agent.trusted_workspace`: project root
- `agent.cursor_flags`: unset
- `agent.claude_flags`: unset
- `run.logs_dir`: `.jaiph/runs`
- `run.debug`: `false`
- `runtime.docker_enabled`: `true` (locally), `false` (when `CI=true`)
- `runtime.docker_image`: `"ubuntu:24.04"`
- `runtime.docker_network`: `"default"`
- `runtime.docker_timeout`: `300`
- `runtime.workspace`: `[".:/jaiph/workspace:rw"]`

Resolution order (highest wins):

1. **Environment variables** — `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`. If a variable is set in the environment, it overrides in-file config and is not overridden when you invoke another module’s workflow via `run` (that module’s config only fills in variables that are not already set).
2. **In-file config** — from the entry workflow’s `config { ... }` block, or from the current module’s block when execution is inside that module’s workflow (e.g. after `run other.default`).
3. **Built-in defaults** — see above.

## Config to env mapping

- `agent.default_model` -> `JAIPH_AGENT_MODEL`
- `agent.command` -> `JAIPH_AGENT_COMMAND`
- `agent.backend` -> `JAIPH_AGENT_BACKEND`
- `agent.trusted_workspace` -> `JAIPH_AGENT_TRUSTED_WORKSPACE`
- `agent.cursor_flags` -> `JAIPH_AGENT_CURSOR_FLAGS`
- `agent.claude_flags` -> `JAIPH_AGENT_CLAUDE_FLAGS`
- `run.logs_dir` -> `JAIPH_RUNS_DIR`
- `run.debug` -> `JAIPH_DEBUG`
- `runtime.docker_enabled` -> `JAIPH_DOCKER_ENABLED`
- `runtime.docker_image` -> `JAIPH_DOCKER_IMAGE`
- `runtime.docker_network` -> `JAIPH_DOCKER_NETWORK`
- `runtime.docker_timeout` -> `JAIPH_DOCKER_TIMEOUT`
- `runtime.workspace` -> _(not overridable via env)_

## Inspect effective config at runtime

Inside workflows, rules, and functions, the resolved config is available as shell environment variables (`JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, etc.). You can log them to debug scoping and overrides:

```jh
workflow default {
  printf 'backend=%s\n' "$JAIPH_AGENT_BACKEND" >> ".jaiph/meta-debug.log"
  printf 'trusted_workspace=%s\n' "$JAIPH_AGENT_TRUSTED_WORKSPACE" >> ".jaiph/meta-debug.log"
}
```

When a workflow calls another module’s workflow via `run alias.default`, the called workflow runs with that module’s config scope: its `config { }` values fill in any variables not already set by the environment. When the call returns, the caller’s environment is restored.

## Created by `jaiph init`

`jaiph init` creates `.jaiph/bootstrap.jh` and syncs `.jaiph/jaiph-skill.md` from your installation. It does not create a config file; use in-file config blocks in your workflow files.
