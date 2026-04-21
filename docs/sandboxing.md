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

## Threat model

Docker sandboxing is designed to contain damage from untrusted or semi-trusted workflow scripts. Understanding what it does and does not protect against helps you make informed decisions about when to enable it.

**What Docker protects against:**

- **Filesystem access** -- Scripts inside the container cannot read or write arbitrary host paths. The container's `/jaiph/workspace` is either an in-container fuse-overlayfs union over a read-only bind of the host workspace (overlay mode, writes land in a tmpfs upper layer and are discarded on exit) or a host-side clone of the workspace mounted read-write (copy mode, the clone is removed on exit). Only the run-artifacts directory (`/jaiph/run`) persists writes back to the host workspace.
- **Process isolation** -- Container processes cannot see or signal host processes. The container runs with `--cap-drop ALL` (overlay mode re-adds `SYS_ADMIN` for fuse-overlayfs; copy mode adds nothing) and `--security-opt no-new-privileges` to prevent privilege escalation. In Linux overlay mode the workflow runs as root inside the container so fuse-overlayfs can mount reliably; copy mode and macOS remain non-root as before.
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

The container's `/jaiph/workspace` always *looks* writable to scripts but never mutates the host checkout. The CLI picks one of two sandbox primitives at launch time:

- **Overlay mode** (selected when `/dev/fuse` exists on the host -- typically Linux). The host workspace is bind-mounted read-only at `/jaiph/workspace-ro`. The runtime entrypoint (`overlay-run.sh`) sets up `fuse-overlayfs` with that read-only bind as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. Writes go to the tmpfs and are discarded on container exit. Requires `--cap-add SYS_ADMIN` and `--device /dev/fuse`.
- **Copy mode** (selected when `/dev/fuse` is missing -- typically macOS Docker Desktop, or when forced via `JAIPH_DOCKER_NO_OVERLAY=1`). Before launching the container, the CLI clones the host workspace (excluding `.jaiph/runs`) into a fresh `<runs-root>/.sandbox-<id>/` directory, then bind-mounts that clone read-write at `/jaiph/workspace`. On macOS the clone uses `cp -cR` (APFS clonefile, near-zero cost); on other platforms it falls back to `cp -pR` and emits a one-line stderr warning. The clone is removed on exit unless `JAIPH_DOCKER_KEEP_SANDBOX=1` is set. No `SYS_ADMIN`, no `/dev/fuse`, no in-container overlay script.

In both modes, run artifacts are written to a separate rw mount at `/jaiph/run` (outside the workspace sandbox) so they persist to the host.

### Enabling Docker

Docker sandboxing is **on by default** for both local development and CI. When `JAIPH_UNSAFE=true` is not set, `runtime.docker_enabled` defaults to `true`. CI environments (`CI=true`) deliberately exercise the same sandbox path users do — landing-page e2e tests and docs sample tests would otherwise skip the sandbox in CI and miss real regressions. The only environment-driven escape hatch is `JAIPH_UNSAFE=true`.

To disable Docker for a local run without setting an environment variable, set `runtime.docker_enabled = false` in a module-level `config` block:

```jh
config {
  runtime.docker_enabled = false
}
```

`runtime.*` keys belong only in module-level config. Placing them in a workflow-level `config` block is a parse error.

The environment variable `JAIPH_DOCKER_ENABLED` overrides both the in-file setting and the unsafe default when set: only the literal string `"true"` enables Docker; any other value disables it. `JAIPH_UNSAFE=true` is the explicit "run on host / skip Docker default" escape hatch for local development when Docker is unwanted.

**Default rule (when no explicit `JAIPH_DOCKER_ENABLED` or in-file `runtime.docker_enabled` is set):**

| Environment | Default |
|-------------|---------|
| Plain local (no `JAIPH_UNSAFE`) | Docker **on** |
| `CI=true` | Docker **on** (CI exercises the same sandbox path as users) |
| `JAIPH_UNSAFE=true` | Docker **off** |

Explicit overrides (`JAIPH_DOCKER_ENABLED` env or in-file `runtime.docker_enabled`) always take precedence over the default rule.

If Docker is enabled but `docker info` fails, the run exits with `E_DOCKER_NOT_FOUND` -- there is no silent fallback to local execution.

### Configuration keys

All Docker-related keys live under `runtime.*` in module-level config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `true` by default (incl. CI); `false` only when `JAIPH_UNSAFE=true` | Enable Docker sandbox for the run. |
| `runtime.docker_image` | string | `"ghcr.io/jaiphlang/jaiph-runtime:<version>"` | Container image. Must already contain `jaiph`. Defaults to the official GHCR runtime image matching the installed jaiph version. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Max execution time in seconds. `0` disables the timeout. |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications (see below). |

Each key is type-checked at parse time. Unknown keys produce `E_PARSE`.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Additionally, `JAIPH_UNSAFE` affects the default for `runtime.docker_enabled` (see [Enabling Docker](#enabling-docker)). `CI=true` does **not** affect the default — CI runs use the same sandbox path users do. Workspace mounts are not overridable via environment.

Precedence: `JAIPH_DOCKER_ENABLED` env > in-file config > unsafe default rule.

If `JAIPH_DOCKER_TIMEOUT` is set but not a valid integer, the default (`300`) is used.

### Mount specifications

Mount strings in `runtime.workspace` define which host paths are visible inside the container. The mount targeting `/jaiph/workspace` selects the workspace source; additional sub-mounts pin parts of the tree to a particular mode (e.g. `"config:ro"` to make a subdir read-only inside the container).

| Form | Segments | Example | Result |
|------|----------|---------|--------|
| Full | 3 | `".:/jaiph/workspace:rw"` | Workspace source. In overlay mode this becomes the read-only lower layer at `/jaiph/workspace-ro`; in copy mode the clone is mounted rw at `/jaiph/workspace`. |
| Shorthand | 2 | `"config:ro"` | Mount `config` under `/jaiph/workspace/config`. In overlay mode the path is duplicated at `/jaiph/workspace-ro/config`; in copy mode the cloned subdirectory is bound at the requested mode. |
| Too few | 1 | `"data"` | `E_PARSE` |
| Too many | 4+ | `"a:b:c:d"` | `E_PARSE` |

Mode must be `ro` or `rw` (otherwise `E_PARSE`). Exactly one mount must target `/jaiph/workspace` -- zero or more than one produces `E_VALIDATE`. The default `[".:/jaiph/workspace:rw"]` satisfies this requirement.

Host paths are resolved relative to the workspace root. In overlay mode each mount is duplicated at the overlay lower-layer path (`/jaiph/workspace-ro/...`) so the overlay wrapper can use it as the read-only source. In copy mode, sub-mounts under `/jaiph/workspace` are bound from the cloned workspace directory.

The following host paths are rejected at mount validation time with `E_VALIDATE_MOUNT`:

- `/` (host root filesystem)
- `/var/run/docker.sock`, `/run/docker.sock` (Docker daemon socket)
- `/proc`, `/sys`, `/dev` (OS internals, including subpaths like `/proc/1/root`)

### Container layout

Overlay mode:

```
/jaiph/
  workspace-ro/       # read-only bind mount of host workspace (overlay lower layer)
  workspace/          # fuse-overlayfs merged view (reads from -ro, writes to tmpfs)
    *.jh              # source files
    .jaiph/           # project config
  run/                # writable bind mount for this run's artifacts (host runs root)
  overlay-run.sh      # runtime-generated entrypoint mounted ro from host temp file
```

Copy mode:

```
/jaiph/
  workspace/          # rw bind mount of <runs-root>/.sandbox-<id>/ on the host
    *.jh              # cloned source files (writes are local to the clone)
    .jaiph/           # cloned config (.jaiph/runs is excluded from the clone)
  run/                # writable bind mount for this run's artifacts (host runs root)
```

The working directory is `/jaiph/workspace`. In overlay mode the host CLI generates `overlay-run.sh` (a short bash script) to a temp file and mounts it read-only at `/jaiph/overlay-run.sh`; the container runs `/jaiph/overlay-run.sh jaiph run --raw <file>`. In copy mode the container runs `jaiph run --raw <file>` directly -- no entrypoint script. The image must already contain `jaiph` — Jaiph does not install itself into the container at runtime.

### Runtime behavior

**Container lifecycle** -- `docker run --rm` launches the container and auto-removes it on exit. `--cap-drop ALL` drops all Linux capabilities; overlay mode re-adds only `SYS_ADMIN` (fuse-overlayfs mount). Copy mode adds nothing. `--security-opt no-new-privileges` prevents any process inside the container from gaining additional privileges. The pseudo-TTY flag (`-t`) is intentionally omitted: Docker's `-t` merges stderr into stdout, which would break the `__JAIPH_EVENT__` stderr-only live contract.

**UID/GID handling on Linux:**

- **Copy mode** -- the container runs directly as `--user <host_uid>:<host_gid>` so writes to the cloned workspace and `/jaiph/run` land owned by the host user.
- **Overlay mode** -- the container runs as `--user 0:0` and executes the workflow as root inside the container. This keeps the overlay path simple and robust on Linux runners where `fusermount3` enforces strict mountpoint checks.

On macOS Docker Desktop the VM transparently translates UIDs across the bind-mount boundary, so no `--user` override is applied.

**stdin** -- The `docker run` process is spawned with stdin set to `ignore` to prevent the Docker CLI from blocking on stdin EOF.

**Events** -- The container's jaiph runs in `--raw` mode: it spawns the runtime with inherited stdio, so `__JAIPH_EVENT__` JSON flows directly to the container's stderr. The host CLI reads Docker's stderr pipe and renders the progress tree. stdout carries plain script output. `STEP_END` events embed `out_content` (and `err_content` on failure) so consumers do not need host paths to step artifact files.

**Sandbox primitive (overlay vs. copy)** -- Selected at launch time. If `/dev/fuse` exists on the host, the CLI uses **overlay mode**: the `overlay-run.sh` wrapper (generated by the host CLI and mounted read-only) sets up `fuse-overlayfs` with the ro bind mount (`/jaiph/workspace-ro`) as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. All workspace writes go to the tmpfs and are discarded on container exit. On Linux hosts, the overlay container is also launched with `--security-opt apparmor=unconfined` because the default Docker AppArmor profile (active on Ubuntu 22.04+, GitHub Actions runners, and similar) denies fuse mounts even when `SYS_ADMIN` and `/dev/fuse` are present. If `fuse-overlayfs` is missing from the image or the mount still fails at runtime, the entrypoint exits with `E_DOCKER_OVERLAY` -- there is no in-container fallback. Set `JAIPH_DOCKER_NO_OVERLAY=1` on the host to opt into copy mode instead. Custom images used in overlay mode must ensure `/jaiph/workspace` is mountable by root (the official image keeps this path root-owned).

If `/dev/fuse` is missing on the host, the CLI uses **copy mode**: before launching the container it clones the workspace into `<runs-root>/.sandbox-<id>/` (excluding `.jaiph/runs`) using `cp -cR` on macOS (APFS clonefile, O(1) per file) or `cp -pR` elsewhere (a real copy; a single stderr warning is printed when the fast path is unavailable). The clone is bind-mounted rw at `/jaiph/workspace`. After the container exits the clone is removed unless `JAIPH_DOCKER_KEEP_SANDBOX=1` is set, in which case the path is left in place and printed to stderr for debugging.

**Run artifacts** -- The host CLI mounts the resolved host runs root at `/jaiph/run:rw` inside the container. By default this is `.jaiph/runs` under the workspace; a relative `JAIPH_RUNS_DIR` is resolved under the workspace; an absolute `JAIPH_RUNS_DIR` must stay within the workspace or the run fails with `E_DOCKER_RUNS_DIR`. `JAIPH_RUNS_DIR` is set to `/jaiph/run` inside the container, so the runtime writes artifacts directly into the requested host path.

**Path remapping** {#path-remapping} -- Inside the container, the runtime records artifact paths relative to `/jaiph/run` (e.g. `/jaiph/run/2026-04-21/07-55-32-say_hello.jh/000003-script__validate_name.err`). These container-internal paths do not exist on the host. After the container exits, the host CLI remaps every container path that starts with `/jaiph/run/` to the corresponding path under the bind-mounted host runs directory (the `sandboxRunDir`). This ensures the failure footer (`Logs:`, `Summary:`, `out:`, `err:`) printed to stderr shows valid **host** paths that can be opened directly. The `run_summary.jsonl` file also records container-internal `out_file` / `err_file` values; the CLI applies the same remapping when reading these fields to locate artifact content for the "Output of failed step" excerpt. When the container meta file is inaccessible from the host (which is typical in Docker mode), the CLI discovers the run directory by scanning the bind-mounted runs directory for the most recent `run_summary.jsonl`. The net effect is that Docker and no-sandbox runs produce identical failure footers — same structure, same host-resolvable paths, same step output excerpt.

**Workspace immutability contract** -- Docker runs cannot directly modify the host workspace. In overlay mode the host checkout is bind-mounted read-only and writes land in a tmpfs upper layer that is discarded on container exit. In copy mode the container writes to a separate host-side clone of the workspace (`<runs-root>/.sandbox-<id>/`), which is removed on container exit unless explicitly kept for debugging. In both modes the only persistence channel from a Docker run to the host is the run-artifacts directory (`/jaiph/run` → host `.jaiph/runs`). Non-Docker (local) runs are unaffected by this contract.

**Workspace patch export** -- To capture workspace changes as a patch, call `artifacts.save_patch(name)` from `jaiphlang/artifacts`; it writes a named `git diff` into the `artifacts/` subdirectory under the run tree. Callers choose when and what to record; output lives alongside other artifacts. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox). The published GHCR runtime image includes `git`.

**Network** -- `"default"` omits `--network`, which uses Docker's default bridge network (outbound access allowed). `"none"` passes `--network none` and fully disables networking -- use this for workflows that should not make external calls. Any other value (e.g. a custom Docker network name) is passed through as-is. Set `runtime.docker_network` in config or `JAIPH_DOCKER_NETWORK` in the environment.

**Timeout** -- When `runtime.docker_timeout` is greater than zero, the CLI sends `SIGTERM` to the container process on overrun, followed by `SIGKILL` after a 5-second grace period. The failure message includes `E_TIMEOUT container execution exceeded timeout`.

**Image pull** -- If the image is not present locally, `docker pull` runs automatically. Pull failure produces `E_DOCKER_PULL`.

### Failure modes

Docker-related errors use `E_DOCKER_*` codes for programmatic detection:

| Error code | Trigger | Behavior |
|------------|---------|----------|
| `E_DOCKER_NOT_FOUND` | `docker info` fails (Docker not installed or daemon not running) | Run exits immediately. No fallback to local execution. |
| `E_DOCKER_PULL` | `docker pull` fails (network error, image not found, auth failure) | Run exits. Check registry access and image name. |
| `E_DOCKER_NO_JAIPH` | Selected image does not contain a `jaiph` CLI | Run exits with guidance to use the official image or install jaiph. |
| `E_DOCKER_RUNS_DIR` | Absolute `JAIPH_RUNS_DIR` points outside the workspace | Run exits. Use a relative path or an absolute path within the workspace. |
| `E_DOCKER_OVERLAY` | Overlay mode selected but `fuse-overlayfs` is missing from the image or the mount fails inside the container | Container exits with code 78. Use the official runtime image, install `fuse-overlayfs` in your custom image, or set `JAIPH_DOCKER_NO_OVERLAY=1` on the host to switch to copy mode. The CLI already passes `--security-opt apparmor=unconfined` on Linux to defeat the default AppArmor fuse-deny; remaining failures usually mean the host kernel itself blocks fuse mounts (rootless docker without the right user-namespace setup, locked-down kernel, etc.). |
| `E_DOCKER_SANDBOX_COPY` | Copy mode failed to clone the host workspace (`cp` returned non-zero) | Run exits before container launch. Inspect the path printed in the error. |
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

The default `runtime.docker_image` is `ghcr.io/jaiphlang/jaiph-runtime:<version>` where `<version>` matches the installed jaiph package version. Published tags (`:<semver>`, `:nightly`, `:latest`) are built from the `runtime/Dockerfile` in the jaiph repository (see the `docker-publish` job in `.github/workflows/ci.yml`). The image includes Node.js, jaiph, `fuse-overlayfs`, agent CLIs where that Dockerfile installs them, and a non-root `jaiph` user (UID 10001).

### Custom images and `jaiph run`

`jaiph run` **always** uses the configured image (`runtime.docker_image`, `JAIPH_DOCKER_IMAGE`, or the default GHCR tag above). It does not run `docker build` for you. Build and publish (or `docker build` + `docker tag`) your own image, then set `runtime.docker_image` / `JAIPH_DOCKER_IMAGE`.

After the image is pulled or found locally, Jaiph verifies that `jaiph` is available inside the container. If the check fails, the run exits with `E_DOCKER_NO_JAIPH`.

`overlay-run.sh` is generated by the host CLI and mounted into the container at runtime.

### Extending the official image

To add project-specific tools or agent CLIs, extend the published image in your own Dockerfile (build locally or in CI), then point `runtime.docker_image` at the result:

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
