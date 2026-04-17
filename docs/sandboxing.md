---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Jaiph provides two independent ways to limit what a workflow can do. **Rules** restrict step types at the language level so validation logic stays small and reviewable. **Docker** (opt-in) runs the entire `jaiph run` workflow inside a container for filesystem and process isolation. You can use either mechanism on its own or combine them.

Both local and Docker runs use the same Node workflow runtime and stream `__JAIPH_EVENT__` on stderr. [Hooks](hooks.md) always run on the host CLI and consume that same event stream, even when the runner is inside a container. For `config` syntax, allowed keys, and precedence rules, see [Configuration](configuration.md). For the full step-type matrix, see [Grammar](grammar.md).

## Rules: structured validation, not mutation

Rules restrict which step types are allowed in their body. The permitted set is: `ensure` (other rules), `run` (scripts only, not workflows), `const` (script/rule captures or bash RHS, not `prompt`), `match`, `fail`, `log` / `logerr`, `return`, `ensure … catch`, and `run … catch`. Raw shell, `prompt`, `send` / `route`, and `run async` are disallowed. See [Grammar -- High-level concepts](grammar.md#high-level-concepts) for the authoritative list.

The runtime executes rules by walking the AST in-process (`NodeWorkflowRuntime.executeRule`). There is no per-rule OS sandbox -- no mount namespace, no automatic read-only filesystem. When a rule runs a script step, that script executes as a normal managed subprocess with full access to paths the process user can reach. Treat rules as non-mutating checks by convention; perform intentional filesystem changes in workflows, not rules.

`jaiph test` executes tests in-process with `NodeTestRunner` and does not use Docker or a separate rule sandbox.

## Docker container isolation

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

Docker applies to `jaiph run` only (not `jaiph test`). When enabled, the entire workflow -- every rule and script step -- runs inside a single container. The container runs `jaiph run --raw <file>` using its own installed jaiph -- not the host's. The `--raw` flag makes jaiph emit `__JAIPH_EVENT__` lines to stderr without rendering a progress tree, so the host CLI can render from those events.

The host workspace is mounted **read-only** to prevent bind-mount deadlocks with concurrent runners on macOS Docker Desktop. A `fuse-overlayfs` copy-on-write overlay makes the workspace appear writable inside the container -- reads come from the host mount, writes go to a tmpfs upper layer and are discarded on exit. Run artifacts are written to a separate rw mount at `/jaiph/run` (outside the overlay), so they persist to the host. If `fuse-overlayfs` is unavailable, the workspace stays read-only (no regression).

### Enabling Docker

Docker sandboxing is opt-in. Set `runtime.docker_enabled = true` in a module-level `config` block:

```jh
config {
  runtime.docker_enabled = true
}
```

`runtime.*` keys belong only in module-level config. Placing them in a workflow-level `config` block is a parse error.

The environment variable `JAIPH_DOCKER_ENABLED` overrides the in-file setting when set: only the literal string `"true"` enables Docker; any other value disables it. When unset, the in-file value (default `false`) applies.

If Docker is enabled but `docker info` fails, the run exits with `E_DOCKER_NOT_FOUND` -- there is no silent fallback to local execution.

### Configuration keys

All Docker-related keys live under `runtime.*` in module-level config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `false` | Enable Docker sandbox for the run. |
| `runtime.docker_image` | string | `"ghcr.io/jaiphlang/jaiph-runtime:<version>"` | Container image. Must already contain `jaiph`. Defaults to the official GHCR runtime image matching the installed jaiph version. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Max execution time in seconds. `0` disables the timeout. |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications (see below). |

Each key is type-checked at parse time. Unknown keys produce `E_PARSE`.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are not overridable via environment.

Precedence: environment variable > in-file config > default.

If `JAIPH_DOCKER_TIMEOUT` is set but not a valid integer, the default (`300`) is used.

### Mount specifications

Mount strings in `runtime.workspace` define which host paths are visible inside the container. All mounts are **forced to read-only** regardless of the specified mode to prevent bind-mount deadlocks on macOS Docker Desktop. The overlay wrapper makes the workspace writable via fuse-overlayfs.

| Form | Segments | Example | Result |
|------|----------|---------|--------|
| Full | 3 | `".:/jaiph/workspace:rw"` | Mount `.` at `/jaiph/workspace` and `/jaiph/workspace-ro` (both read-only; overlay makes workspace writable) |
| Shorthand | 2 | `"config:ro"` | Mount `config` at `/jaiph/workspace/config` and `/jaiph/workspace-ro/config` (read-only) |
| Too few | 1 | `"data"` | `E_PARSE` |
| Too many | 4+ | `"a:b:c:d"` | `E_PARSE` |

Mode must be `ro` or `rw` (otherwise `E_PARSE`). Exactly one mount must target `/jaiph/workspace` -- zero or more than one produces `E_VALIDATE`. The default `[".:/jaiph/workspace:rw"]` satisfies this requirement.

Host paths are resolved relative to the workspace root. Each mount is duplicated at the overlay lower-layer path (`/jaiph/workspace-ro/...`) so the overlay wrapper can use it as the read-only source.

### Container layout

```
/jaiph/
  workspace-ro/       # read-only bind mount of host workspace (overlay lower layer)
  workspace/          # fuse-overlayfs merged view (reads from -ro, writes to tmpfs)
    *.jh              # source files
    .jaiph/           # project config
  run/                # writable bind mount for this run's artifacts (host temp dir)
  overlay-run.sh      # runtime-generated entrypoint mounted ro from host temp file
```

The working directory is `/jaiph/workspace`. The host CLI generates `overlay-run.sh` (a ~10 line bash script) to a temp file and mounts it read-only at `/jaiph/overlay-run.sh`. The container runs `/jaiph/overlay-run.sh jaiph run --raw <file>`. The overlay wrapper sets up fuse-overlayfs, then execs the jaiph command. The image must already contain `jaiph` — Jaiph does not install itself into the container at runtime. No `COPY` in the project Dockerfile is needed for jaiph runtime files — `overlay-run.sh` is a jaiph runtime artifact.

### Runtime behavior

**Container lifecycle** -- `docker run --rm` launches the container and auto-removes it on exit. `--device /dev/fuse` exposes the FUSE device for the overlay. The pseudo-TTY flag (`-t`) is intentionally omitted: Docker's `-t` merges stderr into stdout, which would break the `__JAIPH_EVENT__` stderr-only live contract. On Linux, `--user <uid>:<gid>` maps the container user to the host user.

**stdin** -- The `docker run` process is spawned with stdin set to `ignore` to prevent the Docker CLI from blocking on stdin EOF.

**Events** -- The container's jaiph runs in `--raw` mode: it spawns the runtime with inherited stdio, so `__JAIPH_EVENT__` JSON flows directly to the container's stderr. The host CLI reads Docker's stderr pipe and renders the progress tree. stdout carries plain script output. `STEP_END` events embed `out_content` (and `err_content` on failure) so consumers do not need host paths to step artifact files.

**Overlay** -- The `overlay-run.sh` wrapper (generated by the host CLI and mounted read-only) sets up `fuse-overlayfs` with the ro bind mount (`/jaiph/workspace-ro`) as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. All workspace writes go to the tmpfs and are discarded on container exit. If fuse-overlayfs is unavailable (e.g. the image doesn't include it), the overlay step is skipped and the workspace remains read-only.

**Run artifacts** -- The host CLI mounts the resolved host runs root at `/jaiph/run:rw` inside the container. By default this is `.jaiph/runs` under the workspace; a relative `JAIPH_RUNS_DIR` is resolved under the workspace; an absolute `JAIPH_RUNS_DIR` must stay within the workspace or the run fails with `E_DOCKER_RUNS_DIR`. `JAIPH_RUNS_DIR` is set to `/jaiph/run` inside the container, so the runtime writes artifacts directly into the requested host path.

**Network** -- `"default"` omits `--network` (Docker's default bridge). `"none"` passes `--network none`. Any other value is passed through as-is.

**Timeout** -- When `runtime.docker_timeout` is greater than zero, the CLI sends `SIGTERM` to the container process on overrun, followed by `SIGKILL` after a 5-second grace period. The failure message includes `E_TIMEOUT container execution exceeded timeout`.

**Image pull** -- If the image is not present locally, `docker pull` runs automatically. Pull failure produces `E_DOCKER_PULL`.

### Image contract

**Every Docker image used by Jaiph must already contain a working `jaiph` CLI.** Jaiph does not auto-install itself into containers at runtime — no derived image builds, no `npm pack` bootstrap. If the selected image lacks `jaiph`, the run fails immediately with `E_DOCKER_NO_JAIPH` and guidance to use the official image or install jaiph in a custom image.

### Official runtime image

Jaiph publishes official runtime images to GHCR:

| Tag | Built from | Use case |
|-----|-----------|----------|
| `ghcr.io/jaiphlang/jaiph-runtime:<semver>` | Release tags (`v*`) | Production / pinned versions |
| `ghcr.io/jaiphlang/jaiph-runtime:nightly` | `nightly` branch | Contributors and CI |
| `ghcr.io/jaiphlang/jaiph-runtime:latest` | Latest release tag | Convenience alias |

The default `runtime.docker_image` is `ghcr.io/jaiphlang/jaiph-runtime:<version>` where `<version>` matches the installed jaiph package version. The official image includes Node.js, jaiph, `fuse-overlayfs`, and a non-root `jaiph` user (UID 10001). It does **not** include agent CLIs (Claude Code, cursor-agent) to keep the image small. To add agent CLIs, extend the official image or use a custom `.jaiph/Dockerfile` (see below).

### Dockerfile-based image detection

The runtime considers the image explicitly configured when either `runtime.docker_image` appears in the file or `JAIPH_DOCKER_IMAGE` is set in the environment. In that case, `.jaiph/Dockerfile` is not consulted.

When the image is not explicit:

1. If `.jaiph/Dockerfile` exists in the workspace root, the runtime builds it, tags the result `jaiph-runtime:latest`, and uses that image. Build failure produces `E_DOCKER_BUILD`.
2. Otherwise, the default image (`ghcr.io/jaiphlang/jaiph-runtime:<version>`) is pulled if needed.

After resolving the image (whether from a Dockerfile build, an explicit image, or the default), Jaiph verifies that `jaiph` is available inside the container. If the check fails, the run exits with `E_DOCKER_NO_JAIPH`.

The `jaiph init` scaffold generates a `.jaiph/Dockerfile` that extends the official runtime image with agent CLIs (Claude Code, cursor-agent). The Dockerfile does not need to copy any jaiph runtime files — `overlay-run.sh` is generated by the host CLI and mounted into the container at runtime.

### Extending the official image

To add project-specific tools or agent CLIs to the official image, create a `.jaiph/Dockerfile`:

```dockerfile
FROM ghcr.io/jaiphlang/jaiph-runtime:nightly

USER root
RUN npm install -g @anthropic-ai/claude-code
USER jaiph

# Add project-specific package managers/build tools below.
```

### Environment variable forwarding

All `JAIPH_*` variables from the host are forwarded into the container, **except** `JAIPH_DOCKER_*` variables (excluded to prevent nested Docker execution). `JAIPH_WORKSPACE` is overridden to `/jaiph/workspace` and `JAIPH_RUNS_DIR` is overridden to `/jaiph/run`. The following prefixes are also forwarded for agent authentication:

- `CURSOR_*`
- `ANTHROPIC_*`
- `CLAUDE_*`

### Example

A workflow with Docker sandboxing enabled and an extra read-only mount for a `config` directory (using the shorthand form):

```jh
config {
  runtime.docker_enabled = true
  runtime.docker_timeout = 600
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:ro"
  ]
}

workflow default() {
  log "Running inside Docker"
}
```
