---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Workflows orchestrate **managed scripts** and other steps on the machine where `jaiph run` executes. That power is useful for builds and agents, but it also means a script can read files, call the network, and run arbitrary programs unless you constrain it. Jaiph addresses that at two layers: **language rules** (what may appear in a rule body) and **Docker-backed isolation** for `jaiph run` (on by default via env; see [Enabling Docker](#enabling-docker)). You can rely on rules alone, turn Docker off for host execution, or combine both.

At a high level, the **CLI** chooses local vs Docker launch; the **Node workflow runtime** (`NodeWorkflowRuntime` in `src/runtime/kernel/`) interprets the same AST either way. See [Architecture](architecture.md) for how compile validation, the runner child, and durable artifacts fit together.

Both local and Docker runs stream `__JAIPH_EVENT__` on **stderr** only; [Hooks](hooks.md) always run on the **host** CLI and read that stream, even when the workflow runs in a container. For `config` syntax, allowed keys, and merge rules, see [Configuration](configuration.md). For the full step-type matrix, see [Grammar](grammar.md).

## Rules: structured validation, not mutation

Rules restrict which step types are allowed in their body — enforced at **compile time** in `validateReferences` (`src/transpile/validate.ts`), not by an OS sandbox. The permitted set matches [Grammar — Language concepts](grammar.md#language-concepts): `ensure` (other rules only), `run` (**scripts** only — not workflows), `const` (script/`ensure` captures, `match` expressions, or bash RHS — never `prompt`), `match`, `if`, `fail`, `log` / `logerr`, `return` (strings, identifiers, `return run …` / `return ensure …`, and the managed forms the grammar allows), `ensure … catch`, `run … catch`, and `run … recover`. Inline script steps and managed `log`/`logerr` from inline scripts are allowed where the grammar permits them.

Disallowed in rules: **raw shell lines** (every line must be a recognized Jaiph step — use a `script` and `run`), `prompt`, inbox **`send`** / routing, and **`run async`**. See the grammar page for the authoritative list and examples.

The runtime executes rules by walking the AST in-process (`NodeWorkflowRuntime.executeRule`). There is no per-rule OS sandbox -- no mount namespace, no automatic read-only filesystem. When a rule runs a script step, that script executes as a normal managed subprocess with full access to paths the process user can reach. Treat rules as non-mutating checks by convention; perform intentional filesystem changes in workflows, not rules.

`jaiph test` executes tests in-process with `NodeTestRunner` and does not use Docker or a separate rule sandbox.

## Threat model

Docker sandboxing is designed to contain damage from untrusted or semi-trusted workflow scripts. Understanding what it does and does not protect against helps you make informed decisions about when to enable it.

**What Docker protects against:**

- **Filesystem access** -- Scripts inside the container cannot read or write arbitrary host paths. The container's `/jaiph/workspace` is either an in-container fuse-overlayfs union over a read-only bind of the host workspace (overlay mode, writes land in a tmpfs upper layer and are discarded on exit) or a host-side clone of the workspace mounted read-write (copy mode, the clone is removed on exit). Only the run-artifacts directory (`/jaiph/run`) persists writes back to the host workspace.
- **Process isolation** -- Container processes cannot see or signal host processes. Every sandboxed container uses `--cap-drop ALL` plus `--security-opt no-new-privileges`. **Overlay mode** (Linux) adds capabilities required for `fuse-overlayfs` and for dropping privileges after mount: `SYS_ADMIN`, `SETUID`, `SETGID`, `CHOWN`, and `DAC_READ_SEARCH` (see `buildDockerArgs` in `src/runtime/docker.ts`). **Copy mode** does not add capabilities. The overlay entrypoint (`runtime/overlay-run.sh`) starts as the container user `0:0` so it can mount, then normally **`exec`s `jaiph run` as the host UID/GID** via `setpriv` when `JAIPH_HOST_UID` / `JAIPH_HOST_GID` are set; copy mode uses `--user <host_uid>:<host_gid>` directly. macOS Docker Desktop does not use Linux `--user` overrides (UID mapping is handled by the VM).
- **Credential leakage** -- Environment variable forwarding uses an explicit allowlist: only `JAIPH_*` (except `JAIPH_DOCKER_*`), `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` cross the container boundary. Everything else is dropped.
- **Mount safety** -- The host root filesystem (`/`), Docker socket (`/var/run/docker.sock`, `/run/docker.sock`), and OS internals (`/proc`, `/sys`, `/dev`) cannot be mounted into the container. Attempting to do so produces `E_VALIDATE_MOUNT`.
- **Shell injection safety** -- All Docker CLI invocations (`docker info`, `docker image inspect`, `docker pull`) use `execFileSync` with an explicit argument array, bypassing `/bin/sh`. Image names and other parameters are passed as literal argv entries with no shell expansion, so values containing shell metacharacters (`;`, `$`, backticks, etc.) are never evaluated.

**What Docker does NOT protect against:**

- **Hooks run on the host.** Hook commands in `hooks.json` execute on the host CLI process, not inside the container. A malicious hook definition has full host access. Treat `hooks.json` as trusted configuration.
- **Network egress by default.** Unless `runtime.docker_network` is set to `"none"`, the container has outbound network access via Docker's default bridge. Scripts can reach external services and exfiltrate data through the network.
- **Agent credential forwarding.** `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` variables are forwarded into the container so agent-backed workflows function. Any workflow code in the container can read them from the environment together with outbound network access; treat that as **full disclosure** of those secrets to workflow code.
- **Image supply chain.** Jaiph verifies that the selected image contains `jaiph` but does not verify image signatures or provenance. Use trusted registries and pin image digests for production workloads.
- **Container escapes.** Docker is not a security boundary against a determined attacker with kernel exploits. It raises the bar significantly for script-level mischief but is not equivalent to a VM or hardware-level isolation.

## Docker container isolation

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

Docker applies to `jaiph run` only (not `jaiph test`). Enablement is **environment-driven** (see [Enabling Docker](#enabling-docker)); there is no `jaiph run --docker` flag — the CLI decides from env before spawn. When Docker is active, the entire workflow (every rule and script step) runs inside a **single** container. The container runs `jaiph run --raw <file>` using the **image’s** installed `jaiph`, not the host binary. The `--raw` flag skips the banner and progress UI in that inner process so `__JAIPH_EVENT__` JSON lines go to **stderr** unchanged for the host CLI to parse.

The container's `/jaiph/workspace` always *looks* writable to scripts but never mutates the host checkout. The CLI picks one of two sandbox primitives at launch time:

- **Overlay mode** (selected when `/dev/fuse` exists on the host -- typically Linux). The host workspace is bind-mounted read-only at `/jaiph/workspace-ro`. The runtime entrypoint (`overlay-run.sh`) sets up `fuse-overlayfs` with that read-only bind as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. Writes go to the tmpfs and are discarded on container exit. Requires `/dev/fuse` in the container and the extra Linux capabilities described under [Process isolation](#threat-model) (not only `SYS_ADMIN`).
- **Copy mode** (selected when `/dev/fuse` is missing -- typically macOS Docker Desktop, or when forced via `JAIPH_DOCKER_NO_OVERLAY=1`). Before launching the container, the CLI clones the host workspace (excluding `.jaiph/runs`) into a fresh `<runs-root>/.sandbox-<id>/` directory, then bind-mounts that clone read-write at `/jaiph/workspace`. On macOS the clone uses `cp -cR` (APFS clonefile, near-zero cost); on other platforms it falls back to `cp -pR` and emits a one-line stderr warning. The clone is removed on exit unless `JAIPH_DOCKER_KEEP_SANDBOX=1` is set. No `SYS_ADMIN`, no `/dev/fuse`, no in-container overlay script.

In both modes, run artifacts are written to a separate rw mount at `/jaiph/run` (outside the workspace sandbox) so they persist to the host.

### Enabling Docker

**Turning Docker on or off** uses environment variables only — workflow files cannot enable or disable the container (see [Enabling Docker](#enabling-docker)). **Image, network, and timeout** still come from module `config` and env overrides as in [Configuration keys](#configuration-keys). The idea is that skipping the container always requires an explicit host choice (`JAIPH_UNSAFE` / `JAIPH_DOCKER_ENABLED`), not a change committed to a `.jh` file alone.

Docker is **on by default** for both local development and CI. To run on the host without a sandbox, set `JAIPH_UNSAFE=true`. To control Docker enablement explicitly, set `JAIPH_DOCKER_ENABLED`.

> **Credential warning:** Docker sandboxing **does not isolate agent credentials**. `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` env vars are forwarded into the container and the default network allows outbound access. A malicious script can read these from its environment and exfiltrate them. Set `runtime.docker_network = "none"` for workflows that should not make external calls.

**Precedence (two rows, env only):**

| Check | Result |
|-------|--------|
| `JAIPH_DOCKER_ENABLED` is set | `"true"` enables Docker; any other value disables it |
| Default (no explicit env) | Docker **on**, unless `JAIPH_UNSAFE=true` (Docker **off**) |

CI environments (`CI=true`) deliberately exercise the same sandbox path users do -- `CI=true` alone does not disable Docker.

If Docker is enabled but `docker info` fails, the run exits with `E_DOCKER_NOT_FOUND` and suggests setting `JAIPH_UNSAFE=true` as an escape hatch. There is no silent fallback to local execution.

> **Migration note:** `runtime.docker_enabled` in a `.jh` config block is no longer supported and produces a parse error. Use `JAIPH_DOCKER_ENABLED` or `JAIPH_UNSAFE` in the environment instead.

### Configuration keys

**Docker on/off** is **not** a `runtime.*` key — only `JAIPH_DOCKER_ENABLED` / `JAIPH_UNSAFE` control that (see [Enabling Docker](#enabling-docker)). The keys below live under `runtime.*` in **module-level** `config` only. They are merged as **`JAIPH_DOCKER_*` environment variables > module `runtime.*` > defaults** (`resolveDockerConfig` in `src/runtime/docker.ts`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_image` | string | `"ghcr.io/jaiphlang/jaiph-runtime:<version>"` | Container image. Must already contain `jaiph`. Defaults to the official GHCR runtime image matching the installed jaiph version. |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout_seconds` | integer | `3600` | Max execution time in seconds (default one hour). Must be a non-negative integer; `0` disables the timeout. Negative values produce `E_DOCKER_TIMEOUT`. |

Each key is type-checked at parse time. Unknown keys produce `E_PARSE`. The workspace mount is automatic and not configurable.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Additionally, `JAIPH_UNSAFE=true` disables Docker by default (see [Enabling Docker](#enabling-docker)). `CI=true` does **not** affect the default — CI runs use the same sandbox path users do.

Precedence for **enablement** only: `JAIPH_DOCKER_ENABLED` env > unsafe default rule (see table above). Image, network, and timeout use the env > in-file > default merge described in this section.

If `JAIPH_DOCKER_TIMEOUT` is set but not a valid non-negative integer, the run exits with `E_DOCKER_TIMEOUT`.

### Workspace mount

The workspace mount is automatic and not configurable. The workspace root is always bound into the container — in overlay mode at `/jaiph/workspace-ro` (read-only, with fuse-overlayfs merged at `/jaiph/workspace`), and in copy mode the host-side clone is mounted read-write at `/jaiph/workspace`. There are no user-controlled extra mounts.

The workspace root is validated before launch. The following host paths are rejected with `E_VALIDATE_MOUNT`:

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
  overlay-run.sh      # entrypoint script (from runtime/overlay-run.sh) mounted ro from host temp file
```

Copy mode:

```
/jaiph/
  workspace/          # rw bind mount of <runs-root>/.sandbox-<id>/ on the host
    *.jh              # cloned source files (writes are local to the clone)
    .jaiph/           # cloned config (.jaiph/runs is excluded from the clone)
  run/                # writable bind mount for this run's artifacts (host runs root)
```

The working directory is `/jaiph/workspace`. In overlay mode the host CLI writes `overlay-run.sh` (shipped as `runtime/overlay-run.sh` in the npm package) to a temp file and mounts it read-only at `/jaiph/overlay-run.sh`; the container runs `/jaiph/overlay-run.sh jaiph run --raw <file>`. In copy mode the container runs `jaiph run --raw <file>` directly -- no entrypoint script. The image must already contain `jaiph` — Jaiph does not install itself into the container at runtime.

### Runtime behavior

**Container lifecycle** -- `docker run --rm` launches the container and auto-removes it on exit. `--cap-drop ALL` drops all Linux capabilities; overlay mode re-adds the capability set listed under [Process isolation](#threat-model) (not copy mode). `--security-opt no-new-privileges` is always set. The pseudo-TTY flag (`-t`) is intentionally omitted: Docker's `-t` merges stderr into stdout, which would break the `__JAIPH_EVENT__` stderr-only live contract.

**Signal-safe cleanup** -- When the CLI receives SIGINT (Ctrl-C) or SIGTERM during a Docker run, `cleanupDocker` is called before the process exits. This removes the copy-mode sandbox directory (`<runs-root>/.sandbox-<id>/`) and clears any timeout timer, preventing stale workspace clones from accumulating after interrupted runs. A `process.on("exit")` guard provides a final safety net: if the normal exit path has not already cleaned up, the guard calls `cleanupDocker` synchronously. A `cleaned` flag on `DockerSpawnResult` ensures cleanup runs at most once — there are no double-`rmSync` warnings regardless of which path fires first. SIGKILL cannot be caught and is not handled; a startup-time sweep of stale sandbox directories is out of scope.

**UID/GID handling on Linux:**

- **Copy mode** -- the container runs directly as `--user <host_uid>:<host_gid>` so writes to the cloned workspace and `/jaiph/run` land owned by the host user.
- **Overlay mode** -- the container is started as `--user 0:0` so `fuse-overlayfs` can mount. The host UID/GID are forwarded as `JAIPH_HOST_UID` / `JAIPH_HOST_GID`; `overlay-run.sh` **`chown`s the run mount** (best effort) and then **`exec`s `jaiph run` under `setpriv`** to reuid/regid to the host user when `setpriv` is available. If `setpriv` is missing, the workflow may continue as UID 0 inside the container — use an image that includes `setpriv` (the official runtime does) for the intended behavior.

On **Linux**, if the host UID/GID cannot be determined (`process.getuid()` / `process.getgid()` and `id -u` / `id -g` both fail), `buildDockerArgs` throws `E_DOCKER_UID` and the run exits before the container is launched. This prevents overlay or copy mode from starting without a usable `--user` mapping. On **macOS** Docker Desktop the VM transparently translates UIDs across the bind-mount boundary, so the CLI does not apply Linux-style `--user` overrides and this check does not run.

**stdin** -- The `docker run` process is spawned with stdin set to `ignore` to prevent the Docker CLI from blocking on stdin EOF.

**Events** -- The container's jaiph runs in `--raw` mode: it spawns the runtime with inherited stdio, so `__JAIPH_EVENT__` JSON flows directly to the container's stderr. The host CLI reads Docker's stderr pipe and renders the progress tree. stdout carries plain script output. `STEP_END` events embed `out_content` (and `err_content` on failure) so consumers do not need host paths to step artifact files.

**Sandbox primitive (overlay vs. copy)** -- Selected at launch time. If `/dev/fuse` exists on the host, the CLI uses **overlay mode**: the `overlay-run.sh` wrapper (shipped as `runtime/overlay-run.sh`, written to a temp file and mounted read-only) sets up `fuse-overlayfs` with the ro bind mount (`/jaiph/workspace-ro`) as the lower layer and a tmpfs as the upper layer, merged at `/jaiph/workspace`. All workspace writes go to the tmpfs and are discarded on container exit. On Linux hosts, the overlay container is also launched with `--security-opt apparmor=unconfined` because the default Docker AppArmor profile (active on Ubuntu 22.04+, GitHub Actions runners, and similar) denies fuse mounts even when `SYS_ADMIN` and `/dev/fuse` are present. If `fuse-overlayfs` is missing from the image or the mount still fails at runtime, the entrypoint exits with `E_DOCKER_OVERLAY` -- there is no in-container fallback. Set `JAIPH_DOCKER_NO_OVERLAY=1` on the host to opt into copy mode instead. Custom images used in overlay mode must ensure `/jaiph/workspace` is mountable by root (the official image keeps this path root-owned).

If `/dev/fuse` is missing on the host, the CLI uses **copy mode**: before launching the container it clones the workspace into `<runs-root>/.sandbox-<id>/` (excluding `.jaiph/runs`) using `cp -cR` on macOS (APFS clonefile, O(1) per file) or `cp -pR` elsewhere (a real copy; a single stderr warning is printed when the fast path is unavailable). The clone is bind-mounted rw at `/jaiph/workspace`. After the container exits — whether normally, via signal (SIGINT/SIGTERM), or due to an uncaught error — the clone is removed unless `JAIPH_DOCKER_KEEP_SANDBOX=1` is set, in which case the path is left in place for debugging.

**Run artifacts** -- The host CLI mounts the resolved host runs root at `/jaiph/run:rw` inside the container. By default this is `.jaiph/runs` under the workspace; a relative `JAIPH_RUNS_DIR` is resolved under the workspace; an absolute `JAIPH_RUNS_DIR` must stay within the workspace or the run fails with `E_DOCKER_RUNS_DIR`. `JAIPH_RUNS_DIR` is set to `/jaiph/run` inside the container, so the runtime writes artifacts directly into the requested host path.

**Path remapping** {#path-remapping} -- Inside the container, the runtime records artifact paths relative to `/jaiph/run` (e.g. `/jaiph/run/2026-04-21/07-55-32-say_hello.jh/000003-script__validate_name.err`). These container-internal paths do not exist on the host. After the container exits, the host CLI remaps every container path that starts with `/jaiph/run/` to the corresponding path under the bind-mounted host runs directory (the `sandboxRunDir`). This ensures the failure footer (`Logs:`, `Summary:`, `out:`, `err:`) printed to stderr shows valid **host** paths that can be opened directly. The `run_summary.jsonl` file also records container-internal `out_file` / `err_file` values; the CLI applies the same remapping when reading these fields to locate artifact content for the "Output of failed step" excerpt. When the container meta file is inaccessible from the host (which is typical in Docker mode), the CLI discovers the run directory by scanning the bind-mounted runs directory for a `run_summary.jsonl` whose `WORKFLOW_START` event matches the expected `JAIPH_RUN_ID`. This run-id stamping ensures that concurrent `jaiph run` invocations sharing the same `JAIPH_RUNS_DIR` each report their own run directory, not a sibling's. The net effect is that Docker and no-sandbox runs produce identical failure footers — same structure, same host-resolvable paths, same step output excerpt.

**Workspace immutability contract** -- Docker runs cannot directly modify the host workspace. In overlay mode the host checkout is bind-mounted read-only and writes land in a tmpfs upper layer that is discarded on container exit. In copy mode the container writes to a separate host-side clone of the workspace (`<runs-root>/.sandbox-<id>/`), which is removed on container exit unless explicitly kept for debugging. In both modes the only persistence channel from a Docker run to the host is the run-artifacts directory (`/jaiph/run` → host `.jaiph/runs`). Non-Docker (local) runs are unaffected by this contract.

**Workspace patch export** -- To capture workspace changes as a patch, run `git diff` (or your own exporter) inside the workflow, write the result to a file under the workspace, then call `artifacts.save(local_path)` so the patch lands in the run’s `artifacts/` tree on the host. Callers choose when and what to record. The published GHCR runtime image includes `git` if you use it from a script step. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox).

**Network** -- `"default"` omits `--network`, which uses Docker's default bridge network (outbound access allowed). `"none"` passes `--network none` and fully disables networking -- use this for workflows that should not make external calls. Any other value (e.g. a custom Docker network name) is passed through as-is. Set `runtime.docker_network` in config or `JAIPH_DOCKER_NETWORK` in the environment.

**Timeout** -- When the effective timeout (from `JAIPH_DOCKER_TIMEOUT` or `runtime.docker_timeout_seconds`, after the merge in [Configuration keys](#configuration-keys)) is greater than zero, the CLI arms a timer on the spawned `docker` child; on overrun it sends `SIGTERM`, then `SIGKILL` after a 5-second grace period. The failure message includes `E_TIMEOUT container execution exceeded timeout`. `0` disables the timer.

**Image pre-pull** -- Image preparation (`prepareImage`) runs **before** the CLI banner so Docker's pull overhead does not interleave with the progress tree. If the image is not present locally, a single `pulling image <name>…` status line is written to stderr, then `docker pull --quiet` runs (Docker's native layer progress is suppressed). Pull failure produces `E_DOCKER_PULL`. After the pull (or if the image was already local), `verifyImageHasJaiph` confirms the image contains `jaiph`. The banner and progress tree only begin after image preparation completes.

### Failure modes

Docker-related errors use `E_DOCKER_*` codes for programmatic detection:

| Error code | Trigger | Behavior |
|------------|---------|----------|
| `E_DOCKER_NOT_FOUND` | `docker info` fails (Docker not installed or daemon not running) | Run exits immediately. No fallback to local execution. |
| `E_DOCKER_PULL` | `docker pull` fails (network error, image not found, auth failure) | Run exits. Check registry access and image name. |
| `E_DOCKER_NO_JAIPH` | Selected image does not contain a `jaiph` CLI | Run exits with guidance to use the official image or install jaiph. |
| `E_DOCKER_RUNS_DIR` | Absolute `JAIPH_RUNS_DIR` points outside the workspace | Run exits. Use a relative path or an absolute path within the workspace. |
| `E_DOCKER_OVERLAY` | Overlay mode selected but `fuse-overlayfs` is missing from the image or the mount fails inside the container | Container exits with code 78. Use the official runtime image, install `fuse-overlayfs` in your custom image, or set `JAIPH_DOCKER_NO_OVERLAY=1` on the host to switch to copy mode. The CLI already passes `--security-opt apparmor=unconfined` on Linux to defeat the default AppArmor fuse-deny; remaining failures usually mean the host kernel itself blocks fuse mounts (rootless docker without the right user-namespace setup, locked-down kernel, etc.). |
| `E_DOCKER_TIMEOUT` | `JAIPH_DOCKER_TIMEOUT` or `runtime.docker_timeout_seconds` is not a valid non-negative integer | Run exits before container launch. Value must be a non-negative integer; `0` disables the timeout. |
| `E_DOCKER_UID` | Linux host UID/GID detection failed (`process.getuid` and `id -u` both unavailable) | Run exits before container launch. Ensures the container never silently runs as root. Applies to both copy and overlay modes. |
| `E_DOCKER_SANDBOX_COPY` | Copy mode failed to clone the host workspace (`cp` returned non-zero) | Run exits before container launch. Inspect the path printed in the error. |
| `E_VALIDATE_MOUNT` | Mount targets a denied host path (`/`, `/proc`, docker socket, etc.) | Run exits before container launch. |
| `E_TIMEOUT` | Container exceeds `runtime.docker_timeout_seconds` seconds | Container receives SIGTERM, then SIGKILL after 5s grace period. |

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

`overlay-run.sh` is shipped as `runtime/overlay-run.sh` in the npm package; the host CLI writes it to a temp file and mounts it into the container at runtime.

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

Environment variable forwarding uses an explicit allowlist; everything else is dropped. Only variables matching the following prefixes are forwarded into the container:

- `JAIPH_*` (except `JAIPH_DOCKER_*`, excluded to prevent nested Docker execution)
- `ANTHROPIC_*`
- `CURSOR_*`
- `CLAUDE_*`

`JAIPH_WORKSPACE` is overridden to `/jaiph/workspace` and `JAIPH_RUNS_DIR` is overridden to `/jaiph/run`. `JAIPH_RUN_ID` is forwarded into the container so the runtime reuses the host-generated run identifier instead of creating its own — this ties the container's `run_summary.jsonl` back to the host CLI invocation and prevents concurrent-run misidentification during run-directory discovery.

This allowlist is enforced in `buildDockerArgs` and cannot be overridden. Any variable not matching the allowlist -- including cloud credentials (`AWS_*`, `GCP_*`, etc.), authentication sockets (`SSH_*`), registry tokens (`NPM_TOKEN`, `GITHUB_TOKEN`, `PYPI_*`, `CARGO_*`), and all other host environment -- is silently dropped. If a workflow needs external credentials inside the container, pass them explicitly through `JAIPH_*`-prefixed variables or use a credential proxy.

### Example

A workflow with a custom Docker timeout (Docker is on by default):

```jh
config {
  runtime.docker_timeout_seconds = 600
}

workflow default() {
  log "Running inside Docker"
}
```
