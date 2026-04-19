---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Jaiph provides two independent ways to limit what a workflow can do. **`run readonly`** restricts step types at the language level so validation logic stays small and reviewable. **Docker** (opt-in) runs the entire `jaiph run` workflow inside a container for filesystem and process isolation. You can use either mechanism on its own or combine them.

Both local and Docker runs use the same Node workflow runtime and stream `__JAIPH_EVENT__` on stderr. [Hooks](hooks.md) always run on the host CLI and consume that same event stream, even when the runner is inside a container. For `config` syntax, allowed keys, and precedence rules, see [Configuration](configuration.md). For the full step-type matrix, see [Grammar](grammar.md).

## `run readonly`: structured validation, not mutation

`run readonly ref()` executes a workflow in a read-only context. Inside a `readonly` call, the permitted step set is restricted: `run` (scripts and workflows), `const` (script/workflow captures or bash RHS, not `prompt`), `match`, `fail`, `log` / `logerr`, `return`, and `run … catch`. Raw shell, `prompt`, `send` / `route`, and `run async` are disallowed. See [Grammar — High-level concepts](grammar.md#high-level-concepts) for the authoritative list.

The runtime executes readonly workflow bodies by walking the AST in-process. There is no per-call OS sandbox — no mount namespace, no automatic read-only filesystem. When a readonly workflow runs a script step, that script executes as a normal managed subprocess with full access to paths the process user can reach. Treat readonly workflows as non-mutating checks by convention; perform intentional filesystem changes in unrestricted workflows.

`jaiph test` executes tests in-process with `NodeTestRunner` and does not use Docker or a separate readonly sandbox.

## Threat model

Docker sandboxing is designed to contain damage from untrusted or semi-trusted workflow scripts. Understanding what it does and does not protect against helps you make informed decisions about when to enable it.

**What Docker protects against:**

- **Filesystem access** -- Scripts inside the container cannot read or write arbitrary host paths. The host workspace is mounted read-only; writes go to a tmpfs overlay and are discarded on exit. Only the run-artifacts directory (`/jaiph/run`) persists writes to the host.
- **Process isolation** -- Container processes cannot see or signal host processes. The container runs with `--cap-drop ALL` (only `SYS_ADMIN` is re-added for fuse-overlayfs) and `--security-opt no-new-privileges` to prevent privilege escalation.
- **Credential leakage** -- Sensitive host environment variables (`SSH_*`, `GPG_*`, `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*`, `DOCKER_*`, `KUBE*`, `NPM_TOKEN*`) are never forwarded into the container. Only `JAIPH_*` (except `JAIPH_DOCKER_*`) and agent prefixes (`ANTHROPIC_*`, `CLAUDE_*`, `CURSOR_*`) cross the container boundary.
- **Mount safety** -- The host root filesystem (`/`), Docker socket (`/var/run/docker.sock`, `/run/docker.sock`), and OS internals (`/proc`, `/sys`, `/dev`) cannot be mounted into the container. Attempting to do so produces `E_VALIDATE_MOUNT`.

**What Docker does NOT protect against:**

- **Hooks run on the host.** Hook commands in `hooks.json` execute on the host CLI process, not inside the container. A malicious hook definition has full host access. Treat `hooks.json` as trusted configuration.
- **Network egress by default.** Unless `runtime.docker_network` is set to `"none"`, the container has outbound network access via Docker's default bridge. Scripts can reach external services and exfiltrate data through the network.
- **Agent credential forwarding.** `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` variables are forwarded into the container so agent-backed workflows function. A malicious script can read these from its environment. When the credential-proxy feature lands, these will be replaced by proxy URLs that do not expose raw API keys.
- **Image supply chain.** Jaiph verifies that the selected image contains `jaiph` but does not verify image signatures or provenance. Use trusted registries and pin image digests for production workloads.
- **Container escapes.** Docker is not a security boundary against a determined attacker with kernel exploits. It raises the bar significantly for script-level mischief but is not equivalent to a VM or hardware-level isolation.

## Docker container isolation

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

Docker applies to `jaiph run` only (not `jaiph test`). When enabled, the entire workflow -- every rule and script step -- runs inside a single container. The container runs `jaiph run --raw <file>` using its own installed jaiph -- not the host's. The `--raw` flag makes jaiph emit `__JAIPH_EVENT__` lines to stderr without rendering a progress tree, so the host CLI can render from those events.

The host workspace is mounted **read-only** to prevent bind-mount deadlocks with concurrent runners on macOS Docker Desktop. A `fuse-overlayfs` copy-on-write overlay makes the workspace appear writable inside the container -- reads come from the host mount, writes go to a tmpfs upper layer and are discarded on exit. Run artifacts are written to a separate rw mount at `/jaiph/run` (outside the overlay), so they persist to the host. If `fuse-overlayfs` is unavailable, the workspace stays read-only (no regression).

### Enabling Docker

Docker sandboxing is **on by default** for local development. When neither `CI=true` nor `JAIPH_UNSAFE=true` is set in the environment, `runtime.docker_enabled` defaults to `true`. In CI environments (`CI=true`) or when the user explicitly opts out with `JAIPH_UNSAFE=true`, the default flips to `false`.

To disable Docker for a local run without setting an environment variable, set `runtime.docker_enabled = false` in a module-level `config` block:

```jh
config {
  runtime.docker_enabled = false
}
```

`runtime.*` keys belong only in module-level config. Placing them in a workflow-level `config` block is a parse error.

The environment variable `JAIPH_DOCKER_ENABLED` overrides both the in-file setting and the CI/unsafe default when set: only the literal string `"true"` enables Docker; any other value disables it. `JAIPH_UNSAFE=true` is the explicit "run on host / skip Docker default" escape hatch for local development when Docker is unwanted.

**Default rule (when no explicit `JAIPH_DOCKER_ENABLED` or in-file `runtime.docker_enabled` is set):**

| Environment | Default |
|-------------|---------|
| Plain local (no `CI`, no `JAIPH_UNSAFE`) | Docker **on** |
| `CI=true` | Docker **off** |
| `JAIPH_UNSAFE=true` | Docker **off** |

Explicit overrides (`JAIPH_DOCKER_ENABLED` env or in-file `runtime.docker_enabled`) always take precedence over the default rule.

If Docker is enabled but `docker info` fails, the run exits with `E_DOCKER_NOT_FOUND` -- there is no silent fallback to local execution.

### Configuration keys

All Docker-related keys live under `runtime.*` in module-level config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `true` locally; `false` when `CI=true` or `JAIPH_UNSAFE=true` | Enable Docker sandbox for the run. |
| `runtime.docker_image` | string | `"ghcr.io/jaiphlang/jaiph-runtime:<version>"` | Container image. Must already contain `jaiph`. Defaults to the official GHCR runtime image matching the installed jaiph version. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Max execution time in seconds. `0` disables the timeout. |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications (see below). |

Each key is type-checked at parse time. Unknown keys produce `E_PARSE`.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Additionally, `CI` and `JAIPH_UNSAFE` affect the default for `runtime.docker_enabled` (see [Enabling Docker](#enabling-docker)). Workspace mounts are not overridable via environment.

Precedence: `JAIPH_DOCKER_ENABLED` env > in-file config > CI/unsafe default rule.

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

The following host paths are rejected at mount validation time with `E_VALIDATE_MOUNT`:

- `/` (host root filesystem)
- `/var/run/docker.sock`, `/run/docker.sock` (Docker daemon socket)
- `/proc`, `/sys`, `/dev` (OS internals, including subpaths like `/proc/1/root`)

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

**Container lifecycle** -- `docker run --rm` launches the container and auto-removes it on exit. `--cap-drop ALL --cap-add SYS_ADMIN` drops all Linux capabilities except `SYS_ADMIN` (required for fuse-overlayfs). `--security-opt no-new-privileges` prevents any process inside the container from gaining additional privileges. `--device /dev/fuse` exposes the FUSE device for the overlay. The pseudo-TTY flag (`-t`) is intentionally omitted: Docker's `-t` merges stderr into stdout, which would break the `__JAIPH_EVENT__` stderr-only live contract. On Linux, `--user <uid>:<gid>` maps the container user to the host user.

**stdin** -- The `docker run` process is spawned with stdin set to `ignore` to prevent the Docker CLI from blocking on stdin EOF.

**Events** -- The container's jaiph runs in `--raw` mode: it spawns the runtime with inherited stdio, so `__JAIPH_EVENT__` JSON flows directly to the container's stderr. The host CLI reads Docker's stderr pipe and renders the progress tree. stdout carries plain script output. `STEP_END` events embed `out_content` (and `err_content` on failure) so consumers do not need host paths to step artifact files.

**Overlay** -- The `overlay-run.sh` wrapper (generated by the host CLI and mounted read-only) sets up `fuse-overlayfs` with the ro bind mount (`/jaiph/workspace-ro`) as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. All workspace writes go to the tmpfs and are discarded on container exit. If fuse-overlayfs is unavailable (e.g. the image doesn't include it), the overlay step is skipped and the workspace remains read-only.

**Run artifacts** -- The host CLI mounts the resolved host runs root at `/jaiph/run:rw` inside the container. By default this is `.jaiph/runs` under the workspace; a relative `JAIPH_RUNS_DIR` is resolved under the workspace; an absolute `JAIPH_RUNS_DIR` must stay within the workspace or the run fails with `E_DOCKER_RUNS_DIR`. `JAIPH_RUNS_DIR` is set to `/jaiph/run` inside the container, so the runtime writes artifacts directly into the requested host path.

**Workspace immutability contract** -- Docker runs cannot directly modify the host workspace. The host checkout is bind-mounted read-only; the writable `/jaiph/workspace` inside the container is a sandbox-local copy-on-write layer (fuse-overlayfs or copy fallback) whose state is discarded on container exit. The only persistence channel from a Docker run to the host is the run-artifacts directory (`/jaiph/run` → host `.jaiph/runs`). Non-Docker (local) runs are unaffected by this contract.

**Workspace patch export** -- When a Docker-backed run modifies files under `/jaiph/workspace`, the runtime automatically exports a `workspace.patch` file into the run directory during teardown (`exportWorkspacePatch` in `docker.ts`, called from `NodeWorkflowRuntime`). The patch is generated with `git diff --binary` (after `git add -N .` for untracked files) and is sufficient to review or `git apply` on the host. Patch export is best-effort: it runs regardless of workflow exit status, and failures are reported on stderr without changing the workflow's reported status. When there are no workspace changes, the `workspace.patch` file is omitted (not created). The bundled `.jaiph/Dockerfile` image includes `git`.

**Network** -- `"default"` omits `--network`, which uses Docker's default bridge network (outbound access allowed). `"none"` passes `--network none` and fully disables networking -- use this for workflows that should not make external calls. Any other value (e.g. a custom Docker network name) is passed through as-is. Set `runtime.docker_network` in config or `JAIPH_DOCKER_NETWORK` in the environment.

**Timeout** -- When `runtime.docker_timeout` is greater than zero, the CLI sends `SIGTERM` to the container process on overrun, followed by `SIGKILL` after a 5-second grace period. The failure message includes `E_TIMEOUT container execution exceeded timeout`.

**Image pull** -- If the image is not present locally, `docker pull` runs automatically. Pull failure produces `E_DOCKER_PULL`.

### Failure modes

Docker-related errors use `E_DOCKER_*` codes for programmatic detection:

| Error code | Trigger | Behavior |
|------------|---------|----------|
| `E_DOCKER_NOT_FOUND` | `docker info` fails (Docker not installed or daemon not running) | Run exits immediately. No fallback to local execution. |
| `E_DOCKER_PULL` | `docker pull` fails (network error, image not found, auth failure) | Run exits. Check registry access and image name. |
| `E_DOCKER_BUILD` | `docker build` from `.jaiph/Dockerfile` fails | Run exits. Fix the Dockerfile and retry. |
| `E_DOCKER_NO_JAIPH` | Selected image does not contain a `jaiph` CLI | Run exits with guidance to use the official image or install jaiph. |
| `E_DOCKER_RUNS_DIR` | Absolute `JAIPH_RUNS_DIR` points outside the workspace | Run exits. Use a relative path or an absolute path within the workspace. |
| `E_VALIDATE_MOUNT` | Mount targets a denied host path (`/`, `/proc`, docker socket, etc.) | Run exits before container launch. |
| `E_TIMEOUT` | Container exceeds `runtime.docker_timeout` seconds | Container receives SIGTERM, then SIGKILL after 5s grace period. |

All failures are deterministic and produce non-zero exit codes. There is no silent fallback from Docker to local execution.

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

The following prefixes are **never** forwarded, even if present on the host:

- `SSH_*`, `GPG_*` -- authentication agent sockets and signing keys
- `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*` -- cloud provider credentials
- `DOCKER_*` -- Docker daemon configuration (prevents container-in-container)
- `KUBE*` -- Kubernetes configuration
- `NPM_TOKEN*` -- package registry credentials

This denylist is enforced in `buildDockerArgs` and cannot be overridden. If a workflow needs cloud credentials inside the container, pass them explicitly through `JAIPH_*`-prefixed variables or use a credential proxy.

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

## Per-call isolation with `run isolated`

`run isolated` provides OS-level isolation at the call site. Each `run isolated foo()` spawns a dedicated Docker container with a fuse-overlayfs overlay: the host workspace is read-only, writes land in a discarded upper layer, and the branch cannot see host processes or credentials.

### Syntax

```jh
workflow default() {
  # Synchronous isolated call
  run isolated review()

  # Capture return value from an isolated call
  const result = run isolated analyze()

  # Async + isolated: spawns N containers in parallel
  const a = run async isolated branch_a()
  const b = run async isolated branch_b()
}
```

`isolated` is a modifier on `run`, like `async`. The two compose: `run async isolated` spawns the branch in a container and returns immediately. Calls inside an isolated body (`run foo()` without the `isolated` modifier) execute in the same container — there is no double isolation.

### What `isolated` guarantees

1. **Read-only host filesystem.** Writes from the branch land in an overlay upper layer, discarded on teardown.
2. **Separate PID namespace.** The branch cannot signal or inspect host processes.
3. **Credential denylist.** `SSH_*`, `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*`, `DOCKER_*`, `KUBE*`, and `NPM_TOKEN*` are never forwarded.
4. **No silent fallback.** If the backend is unavailable, `run isolated` is a hard error — it never degrades to a non-isolating copy.
5. **No on/off switch.** There is no env var or config key to disable isolation.

### Branch outputs

Writes inside an isolated branch are discarded on teardown, but the run artifact directory (`/jaiph/run`) is host-mounted and survives. The `jaiphlang/workspace` standard library provides two primitives for passing data out of a branch:

- `workspace.export_patch(name)` — packages git changes into a patch file at `.jaiph/runs/<run_id>/branches/<branch_id>/<name>` and returns the absolute host path.
- `workspace.export(local_path, name)` — copies a file from the branch workspace to the same location and returns the absolute host path.

The coordinator reads the returned path after the branch handle resolves. A branch that does not call an export primitive simply returns whatever its function returned — the runtime does not require an export.

See [Libraries — Standard library: workspace](libraries.md#standard-library-workspace) for the full API and a candidate-pattern example.

### Backend: Docker + fuse-overlayfs

The v1 backend requires Docker with fuse-overlayfs support. The container runs with `--cap-drop ALL --cap-add SYS_ADMIN --device /dev/fuse`. Run artifacts are written to a host-mounted directory (`/jaiph/run`) that survives container teardown.

The container image defaults to the official GHCR image (`ghcr.io/jaiphlang/jaiph-runtime:<version>`). Override with `JAIPH_ISOLATED_IMAGE` for custom images.

### Nested isolation is forbidden

`run isolated` inside an already-isolated context is a compile-time error. The compiler walks the static call graph: if `run isolated A()` is written and `A` transitively reaches another `run isolated`, the program is rejected. A runtime guard (`JAIPH_ISOLATED=1` sentinel) provides defense-in-depth.

### Host requirements

- Docker daemon running (`docker info` must succeed)
- fuse-overlayfs installed in the container image (included in the official image)
- `/dev/fuse` available to the Docker VM

If any requirement is missing, `run isolated` fails with an actionable error message.

For the formal specification, see [Spec: Handle, Isolation, and Recover Composition](spec-async-isolated.md).
