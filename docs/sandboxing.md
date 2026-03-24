---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Workflows mix shell, agents, and inbox routing. That makes it easy to accidentally depend on mutable global state or to run untrusted code with full host access. **Sandboxing** is how Jaiph narrows those risks: it separates *what runs where* and, on supported Linux setups, makes rule checks harder to abuse for destructive filesystem writes.

Jaiph provides two **independent** layers:

1. **Rule-level read-only isolation** — every `rule` runs in a subprocess. On Linux, when mount-namespace tooling is available, the filesystem can be remounted read-only inside that subprocess. Elsewhere, rules still run in a child shell so an `exit` inside a rule does not tear down the parent workflow, but the host filesystem may stay writable (see below).

2. **Docker container isolation** — optional. The transpiled workflow runs inside a container that receives only generated Bash, the shell stdlib, and copied runtime modules. Jaiph sources, TypeScript, and Node from the host toolchain are not required inside the container for the run itself.

The layers stack: rule-level isolation still applies to rules executed inside Docker.

For general `config` syntax, allowed keys, and precedence with environment variables, see [Configuration](configuration.md). Docker-related keys are documented here in detail.

## Rule-level read-only isolation

Every `rule` block is emitted so the implementation runs under `jaiph::execute_readonly` (see **Rules** under [Transpilation](grammar.md#transpilation) in the grammar doc). You do not configure this; the transpiler wires it automatically.

**On Linux**, when all of the following hold — `unshare` and `sudo` on `PATH`, passwordless `sudo` (`sudo -n`), and a working `unshare -m` — the rule body runs under:

```bash
sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" unshare -m bash -c '
  mount --make-rprivate /
  mount -o remount,ro /
  ... invoke the rule function ...
'
```

The mount namespace makes the filesystem read-only for the duration of the rule: reads work; creating, modifying, or deleting files on mounted filesystems should fail. `JAIPH_PRECEDING_FILES` is forwarded so agent-related behavior that depends on it still works under `sudo`.

**Otherwise** (typical macOS install, containers without usable namespaces, or missing passwordless sudo): the implementation falls back to a child `bash` that invokes the same function. Process boundaries remain (e.g. `exit` in a rule does not kill the workflow runner), but **the filesystem is not forced read-only**. Treat rules as non-mutating checks in your design; rely on Linux + the prerequisites above for enforcement.

All shell functions are exported into the child environment so rule bodies can call helpers and shims defined in the same module.

## Docker container isolation

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

### Where Docker settings may live

`runtime.*` keys belong only in a **module-level** `config { ... }` block (top of the `.jh` file). They are **not** allowed inside a **workflow-level** `config` block (workflow blocks may only override `agent.*` and `run.*`). Putting `runtime.*` in a workflow-level block is a parse error.

### Enabling Docker sandbox

Docker sandboxing is **opt-in**. Set `runtime.docker_enabled = true` in module-level config, or control enablement with `JAIPH_DOCKER_ENABLED`:

```jh
config {
  runtime.docker_enabled = true
}
```

If `JAIPH_DOCKER_ENABLED` is **set** in the environment, it overrides in-file `runtime.docker_enabled`: only the literal string `true` turns Docker on; `false` or any other value turns it off. If `JAIPH_DOCKER_ENABLED` is **unset**, the in-file value (default `false`) applies.

When Docker is enabled but the `docker` binary is not usable (`docker info` fails), the run fails with `E_DOCKER_NOT_FOUND` (no silent fallback).

### Configuration keys

All Docker-related keys live under `runtime.*` in module-level config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `false` | Enable Docker sandbox for the run. |
| `runtime.docker_image` | string | `"ubuntu:24.04"` | Container image to use. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Maximum execution time in seconds (`0` disables the timeout timer). |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications. |

Each key enforces its expected type at parse time. Unknown config keys anywhere in `config` produce `E_PARSE` (message lists allowed keys).

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are **not** overridable via env.

Precedence: `JAIPH_DOCKER_*` environment variables → in-file config → defaults.

If `JAIPH_DOCKER_TIMEOUT` is set but not a valid integer, the default timeout (`300`) is used.

### Mount parsing rules

Mount strings in `runtime.workspace` use these forms:

- **Full form** (3 segments): `"host_path:container_path:mode"` — mounts `host_path` at `container_path` with mode `ro` or `rw`.
- **Shorthand** (2 segments): `"host_path:mode"` — mounts at `/jaiph/workspace/<host_path>` (relative segment; may contain further path components) with the given mode.
- **1 segment** — invalid (`E_PARSE` from mount parsing when Docker config is resolved).
- Mode must be `ro` or `rw` — otherwise `E_PARSE`.
- Exactly one mount must target `/jaiph/workspace` — `E_VALIDATE` if zero or more than one. Omitting `runtime.workspace` uses the default `[".:/jaiph/workspace:rw"]`, which satisfies this.

Host paths are resolved relative to the workspace root when building `docker run` `-v` arguments.

### Workspace structure inside the container

```
/jaiph/
  generated/          # mounted read-only
    <script>.sh       # transpiled bash script(s); see below
    jaiph_stdlib.sh   # shell stdlib
    runtime/          # shell runtime modules
      events.sh
      test-mode.sh
      steps.sh
      inbox.sh
      prompt.sh
      sandbox.sh
  workspace/          # the mount targeting /jaiph/workspace (read-write root)
    .jaiph/
      runs/
        <YYYY-MM-DD>/
          <HH-MM-SS>-<source-file>/
            000001-<module>__<step>.out
            000002-<module>__<step>.out
            ...
```

- **`/jaiph/generated/`** — Contains `jaiph_stdlib.sh`, the primary generated workflow script, and the `runtime/` copies listed above. If the build produced additional `.sh` files (for example imports), those are copied into the same tree under `generated/` so the entry script’s `source` paths keep working. Everything under `generated/` is mounted read-only. `JAIPH_STDLIB` is set to `/jaiph/generated/jaiph_stdlib.sh` inside the container.
- **Working directory** — `/jaiph/workspace`.
- **What is not shipped as Jaiph sources** — The container is meant to run with transpiled Bash and shell runtime only; no `.jh` sources, TypeScript, or host Node install are required for that layout.

The CLI also mounts the host directory containing the run meta file read-write at the same path inside the container so the wrapper can record exit status and paths.

### Docker behavior

- `docker run --rm` with UID/GID mapping (`--user $(id -u):$(id -g)`) on Linux when `id` succeeds; other platforms omit `--user` if mapping is not applied.
- **Structured events** — The run wrapper duplicates stderr to fd 3 (`exec 3>&2`); step events are written to that fd so they land on stderr in normal runs. With `docker run -t`, Docker typically merges the container’s stderr into the stdout stream the CLI reads. The CLI then line-buffers stdout in Docker mode, treats lines that parse as `__JAIPH_EVENT__` JSON as events, and prints the rest as user-facing output. Without a TTY, events and user output follow the usual stdout/stderr split from the container. Interleaving and timing can still differ from a non-Docker run when a TTY is attached — that is a known limitation.
- **`STEP_END` and step logs** — The shell runtime embeds `out_content` in every `STEP_END` event and `err_content` when the step failed, so consumers do not need host paths to step `.out`/`.err` files (critical in Docker). Payloads are JSON-escaped (`jaiph::json_escape` in `events.sh`) per RFC 8259 for control characters through `U+001F` plus `\` and `"`. Embedded content is capped at 1 MiB; larger output is truncated with a `[truncated]` marker while full logs remain in `out_file` / `err_file` under the run directory. After a run, failure summaries prefer embedded fields when present and may fall back to reading files for older summaries that predate embedding.
- Docker missing — `E_DOCKER_NOT_FOUND` (no silent fallback).
- Image — If not present locally, `docker pull` is attempted; pull failure → `E_DOCKER_PULL`.
- Timeout — When `runtime.docker_timeout` is greater than zero, overrun kills the container; the CLI surfaces `E_TIMEOUT` when the run fails after a timeout.
- Network — `"default"` omits `--network` (Docker’s default bridge). `"none"` passes `--network none`. Any other value is passed through to `docker run --network`.

### Dockerfile-based image detection

The runtime treats the image as **explicitly configured** if **either** `runtime.docker_image` appears in the file (any value) **or** `JAIPH_DOCKER_IMAGE` is set in the environment. In that case `.jaiph/Dockerfile` is **not** consulted.

When the image is **not** explicit (no in-file `runtime.docker_image` and no `JAIPH_DOCKER_IMAGE`):

1. If `.jaiph/Dockerfile` exists in the workspace root, the runtime runs `docker build`, tags the result `jaiph-runtime:latest`, and uses that image.
2. Otherwise it uses the configured image name (default `ubuntu:24.04`), pulling if needed.

Build failure → `E_DOCKER_BUILD`.

The repository’s example `.jaiph/Dockerfile` includes:

- **Base image**: `ubuntu:latest`
- **Node.js** — latest LTS from NodeSource (used by `jaiph::stream_json_to_text` in `prompt.sh`)
- **Claude Code CLI** — `@anthropic-ai/claude-code`
- **cursor-agent** — installed via Cursor’s distribution, normalized to `/usr/local/bin/cursor-agent` when possible
- **Utilities** — `bash`, `curl`, `git`, `ca-certificates`, `gnupg`

### Agent environment variable forwarding

Besides variables forwarded as part of the normal `JAIPH_*` pass-through (except `JAIPH_STDLIB`, which the driver overrides), the following prefixes are forwarded for agent authentication and tooling:

- `CURSOR_*`
- `ANTHROPIC_*`
- `CLAUDE_*`

### Docker path remapping

When Docker mode is enabled, the CLI remaps workspace-related environment variables before passing them into the container so run artifacts land under the workspace mount.

- `JAIPH_WORKSPACE` is always `/jaiph/workspace` inside the container.
- `JAIPH_RUNS_DIR`:
  - **Relative** (e.g. `custom_runs`) — unchanged; resolved under `/jaiph/workspace`, which maps back to the host via the workspace mount.
  - **Absolute path inside the host workspace** — rewritten to the equivalent path under `/jaiph/workspace`.
  - **Absolute path outside the workspace** — `E_DOCKER_RUNS_DIR`; use a relative path or a directory inside the workspace.

Configure `JAIPH_RUNS_DIR` the same way as for a non-Docker run; remapping is automatic.

### Example

Minimal workflow with Docker sandbox enabled (expects a `config` directory beside the workflow if you keep the extra read-only mount):

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
