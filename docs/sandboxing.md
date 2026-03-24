---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Jaiph provides two independent layers of execution isolation:

1. **Rule-level read-only isolation** — rules always execute in an isolated subprocess. On Linux with `unshare` available, the filesystem is remounted read-only inside a mount namespace, preventing rules from modifying the host. On macOS (or when `unshare` is unavailable), rules still run in a child shell for process isolation, but without filesystem write protection.

2. **Docker container isolation** — opt-in. The entire transpiled workflow runs inside a Docker container, receiving only the transpiled bash script and the shell stdlib. No Jaiph source files, TypeScript, or Node.js enter the container.

These layers are independent: rule-level isolation applies inside Docker containers too.

## Rule-level read-only isolation

Every `rule` block executes through `jaiph::execute_readonly`, which wraps the rule body in a subprocess. This happens automatically at transpile time — you don't need to configure anything.

**On Linux** (with `unshare` and passwordless `sudo` available):

```bash
sudo unshare -m bash -c '
  mount --make-rprivate /
  mount -o remount,ro /
  your_rule_function "$@"
'
```

The mount namespace makes the entire filesystem read-only for the duration of the rule. The rule can read files but cannot create, modify, or delete anything on disk. This enforces the principle that rules are pure assertions — they check conditions but don't change state.

**On macOS** (or when `unshare`/`sudo` are unavailable):

The rule still runs in a child `bash` process for process isolation (an `exit` inside a rule won't kill the parent workflow), but the filesystem remains writable. This is a best-effort fallback.

All currently defined shell functions are exported into the child process so rule bodies can call helpers and shims as expected.

## Docker container isolation

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

### Enabling Docker sandbox

Docker sandboxing is **opt-in**. Set `runtime.docker_enabled = true` in your config block or export `JAIPH_DOCKER_ENABLED=true`:

```jh
config {
  runtime.docker_enabled = true
}
```

When Docker is enabled but the `docker` binary is not found, the run fails with `E_DOCKER_NOT_FOUND` (no silent fallback).

### Configuration keys

All Docker-related keys live under `runtime.*` in the config block:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `false` | Enable Docker sandbox for the run. |
| `runtime.docker_image` | string | `"ubuntu:24.04"` | Container image to use. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Maximum execution time in seconds. |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications. |

Each key enforces its expected type: assigning a string to an integer key, or a boolean to a string key, etc., produces `E_PARSE`. Unknown `runtime.*` keys also produce `E_PARSE`.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are not overridable via env.

Precedence: env vars (`JAIPH_DOCKER_*`) > in-file config > defaults.

### Mount parsing rules

Mount strings in `runtime.workspace` follow these forms:

- **Full form** (3 segments): `"host_path:container_path:mode"` — mounts `host_path` at `container_path` with mode `ro` or `rw`.
- **Shorthand** (2 segments): `"host_path:mode"` — mounts at `/jaiph/workspace/<host_path>` with the given mode.
- **1 segment** — `E_PARSE` (invalid).
- Mode must be `ro` or `rw` — `E_PARSE` otherwise.
- Exactly one mount must target `/jaiph/workspace` — `E_VALIDATE` if zero or more than one match. If `runtime.workspace` is omitted, the default `[".:/jaiph/workspace:rw"]` satisfies this.

### Workspace structure inside the container

```
/jaiph/
  generated/          # mounted read-only
    <script>.sh       # transpiled bash script(s)
    jaiph_stdlib.sh   # shell stdlib
    runtime/          # shell runtime modules
      events.sh
      steps.sh
      prompt.sh
      inbox.sh
      sandbox.sh
      test-mode.sh
  workspace/          # the mount targeting /jaiph/workspace (read-write root)
    .jaiph/
      runs/
        <YYYY-MM-DD>/
          <HH-MM-SS>-<source-file>/
            000001-<module>__<step>.out
            000002-<module>__<step>.out
            ...
```

- `/jaiph/generated/` contains the transpiled `.sh` script(s), `jaiph_stdlib.sh`, and the `runtime/` shell modules. All mounted read-only. `JAIPH_STDLIB` is set to `/jaiph/generated/jaiph_stdlib.sh` inside the container.
- The container working directory is set to `/jaiph/workspace`.
- Container receives **only** transpiled bash and the shell runtime. No Jaiph source files, no TypeScript, no Node.js.

### Docker behavior

- `docker run --rm` with proper UID/GID mapping (`--user $(id -u):$(id -g)` on Linux).
- TTY passthrough: `-t` flag when `process.stdout.isTTY` is true. Because Docker with `-t` merges the container's stderr into stdout, the CLI buffers Docker stdout line-by-line and filters out `__JAIPH_EVENT__` lines (routing them through the event handler instead). This ensures the progress tree output is identical whether Docker is enabled or not.
- Step output reporting: the bash stdlib always embeds `out_content` in `STEP_END` events (and `err_content` for failed steps), regardless of dispatch status. The CLI uses this embedded content exclusively for display — it never reads `out_file`/`err_file` from disk for rendering. This makes step output identical in Docker and non-Docker modes. Embedded strings are escaped in the runtime (`jaiph::json_escape` in `events.sh`) per RFC 8259 (control characters through `U+001F`, plus `\` and `"`), so event lines stay valid JSON even when logs contain tabs or ANSI sequences. Embedded content is capped at 1 MB; larger output is truncated with a `[truncated]` marker. The full output remains in `out_file`/`err_file` on disk for debugging and archival.
- Docker TTY stream merging: Docker with `-t` merges the container's stderr into stdout. The CLI demuxes event lines from user output via line-based buffering. Ordering and timing of interleaved stdout/stderr may still differ from non-Docker mode — this is a known limitation.
- Docker missing — `E_DOCKER_NOT_FOUND` (no silent fallback).
- Image auto-pulled if missing; pull failure produces `E_DOCKER_PULL`.
- Timeout kills container and reports `E_TIMEOUT`.
- Network: `"default"` omits `--network` flag (uses Docker bridge). `"none"` passes `--network none`. Any other value is passed verbatim.

### Dockerfile-based image detection

When no explicit `docker_image` is configured (neither `JAIPH_DOCKER_IMAGE` env var nor in-file `runtime.docker_image`), the runtime checks for `.jaiph/Dockerfile` in the workspace root. If present:

1. The runtime runs `docker build` from that Dockerfile and tags the result as `jaiph-runtime:latest`.
2. The built image is used for the run instead of the default `ubuntu:24.04`.

Build failure produces `E_DOCKER_BUILD`. If `.jaiph/Dockerfile` does not exist, the runtime falls back to the default image (`ubuntu:24.04`). When an explicit image is configured, the Dockerfile is ignored entirely.

The shipped `.jaiph/Dockerfile` includes:

- **Base image**: `ubuntu:latest`
- **Node.js** latest LTS (required by `jaiph::stream_json_to_text` in `prompt.sh`)
- **Claude Code CLI** (`@anthropic-ai/claude-code`)
- **cursor-agent** (Cursor's agent backend)
- Standard utilities: `bash`, `curl`, `git`, `ca-certificates`, `gnupg`

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

### Example

Minimal workflow with Docker sandbox enabled:

```jh
config {
  runtime.docker_enabled = true
  runtime.docker_image = "ubuntu:24.04"
  runtime.docker_timeout = 600
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:config:ro"
  ]
}

workflow default {
  echo "Running inside Docker"
}
```
