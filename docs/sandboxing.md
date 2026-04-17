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

Docker applies to `jaiph run` only (not `jaiph test`). When enabled, the entire workflow -- every rule and script step -- runs inside a single container. The host CLI compiles the workflow and copies the compiled JS + scripts into a temporary directory, which is mounted read-only at `/jaiph/generated/` inside the container. The container runs the raw Node runtime (`node-workflow-runner.js`) directly -- not the full `jaiph` CLI -- so it emits `__JAIPH_EVENT__` to stderr without any rendering. The host CLI renders the progress tree from those events.

The host workspace is mounted **read-only** to prevent bind-mount deadlocks with concurrent runners on macOS Docker Desktop. A writable sub-mount at `.jaiph/runs` lets the runtime write run artifacts that are immediately visible on the host. There is no delta sync or copy-on-write overlay.

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
| `runtime.docker_image` | string | `"node:20-bookworm"` | Container image (must include Node.js; use `.jaiph/Dockerfile` for custom images). |
| `runtime.docker_network` | string | `"default"` | Docker network mode. |
| `runtime.docker_timeout` | integer | `300` | Max execution time in seconds. `0` disables the timeout. |
| `runtime.workspace` | string array | `[".:/jaiph/workspace:rw"]` | Mount specifications (see below). |

Each key is type-checked at parse time. Unknown keys produce `E_PARSE`.

#### Environment variable overrides

Following the `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are not overridable via environment.

Precedence: environment variable > in-file config > default.

If `JAIPH_DOCKER_TIMEOUT` is set but not a valid integer, the default (`300`) is used.

### Mount specifications

Mount strings in `runtime.workspace` define which host paths are visible inside the container. All mounts are **forced to read-only** regardless of the specified mode to prevent bind-mount deadlocks on macOS Docker Desktop.

| Form | Segments | Example | Result |
|------|----------|---------|--------|
| Full | 3 | `".:/jaiph/workspace:rw"` | Mount `.` at `/jaiph/workspace` (forced read-only) |
| Shorthand | 2 | `"config:ro"` | Mount `config` at `/jaiph/workspace/config` (read-only) |
| Too few | 1 | `"data"` | `E_PARSE` |
| Too many | 4+ | `"a:b:c:d"` | `E_PARSE` |

Mode must be `ro` or `rw` (otherwise `E_PARSE`). Exactly one mount must target `/jaiph/workspace` -- zero or more than one produces `E_VALIDATE`. The default `[".:/jaiph/workspace:rw"]` satisfies this requirement.

Host paths are resolved relative to the workspace root.

### Container layout

```
/jaiph/
  generated/          # host-compiled JS + scripts (read-only mount)
    src/              # compiled runtime kernel (node-workflow-runner.js, etc.)
    scripts/          # extracted script step files
  workspace/          # read-only bind mount of host workspace
    *.jh              # source files
    .jaiph/
      runs/           # run artifacts (writable sub-mount)
  meta/               # meta file IPC directory (writable mount)
```

The working directory is `/jaiph/workspace`. The host CLI compiles the workflow and copies the JS source tree + scripts to a temporary directory, mounted at `/jaiph/generated/`. The container runs `node /jaiph/generated/src/runtime/kernel/node-workflow-runner.js` directly.

### Runtime behavior

**Container lifecycle** -- `docker run --rm` launches the container and auto-removes it on exit. The pseudo-TTY flag (`-t`) is intentionally omitted: Docker's `-t` merges stderr into stdout, which would break the `__JAIPH_EVENT__` stderr-only live contract. On Linux, `--user <uid>:<gid>` maps the container user to the host user.

**stdin** -- The `docker run` process is spawned with stdin set to `ignore` to prevent the Docker CLI from blocking on stdin EOF.

**Events** -- The raw Node runtime writes `__JAIPH_EVENT__` JSON to stderr, the same channel used for local runs. The host CLI listens on stderr and renders the progress tree; stdout carries plain script output. `STEP_END` events embed `out_content` (and `err_content` on failure) so consumers do not need host paths to step artifact files. Embedded content is capped at 1 MiB; larger output is truncated with a `[truncated]` marker while full logs remain on disk.

**Run artifacts** -- The `.jaiph/runs` directory is mounted as a writable sub-mount inside the container. The runtime writes run artifacts (logs, summary) directly to this mount, making them immediately visible on the host. After the container exits, the host CLI reads the meta file (mounted via `/jaiph/meta/`) to discover `run_dir` and `summary_file` paths, remapping container paths back to host paths.

**Network** -- `"default"` omits `--network` (Docker's default bridge). `"none"` passes `--network none`. Any other value is passed through as-is.

**Timeout** -- When `runtime.docker_timeout` is greater than zero, the CLI sends `SIGTERM` to the container process on overrun, followed by `SIGKILL` after a 5-second grace period. The failure message includes `E_TIMEOUT container execution exceeded timeout`.

**Image pull** -- If the image is not present locally, `docker pull` runs automatically. Pull failure produces `E_DOCKER_PULL`.

### Dockerfile-based image detection

The runtime considers the image explicitly configured when either `runtime.docker_image` appears in the file or `JAIPH_DOCKER_IMAGE` is set in the environment. In that case, `.jaiph/Dockerfile` is not consulted.

When the image is not explicit:

1. If `.jaiph/Dockerfile` exists in the workspace root, the runtime builds it, tags the result `jaiph-runtime:latest`, and uses that image. Build failure produces `E_DOCKER_BUILD`.
2. Otherwise, the default image (`node:20-bookworm`) is pulled if needed.

The repository's example `.jaiph/Dockerfile` includes `ubuntu:latest` as a base, Node.js LTS from NodeSource, Claude Code CLI, cursor-agent, and common utilities. The image creates a non-root `jaiph` user (UID 10001) and sets `USER jaiph` -- this is required because tools like Claude Code refuse `--dangerously-skip-permissions` when running as root. The container does not need `jaiph` installed for execution -- the host provides the compiled runtime via the `/jaiph/generated/` mount.

### Environment variable forwarding

All `JAIPH_*` variables from the host are forwarded into the container, **except** `JAIPH_DOCKER_*` variables (excluded to prevent nested Docker execution) and `JAIPH_META_FILE` / `JAIPH_SCRIPTS` (overridden to container paths). The following prefixes are also forwarded for agent authentication:

- `CURSOR_*`
- `ANTHROPIC_*`
- `CLAUDE_*`

### Path remapping

The CLI automatically remaps workspace-related variables so run artifacts land under the workspace mount:

- `JAIPH_WORKSPACE` is always `/jaiph/workspace` inside the container.
- `JAIPH_RUNS_DIR`:
  - **Relative** (e.g. `custom_runs`) -- unchanged; resolves under `/jaiph/workspace` via the mount.
  - **Absolute, inside host workspace** -- rewritten to the equivalent path under `/jaiph/workspace`.
  - **Absolute, outside host workspace** -- rejected with `E_DOCKER_RUNS_DIR`. Use a relative path or a directory inside the workspace instead.

You do not need to configure `JAIPH_RUNS_DIR` differently for Docker runs; remapping is automatic.

**Post-run artifact discovery.** After the container exits, the host CLI reads the meta file (mounted via `/jaiph/meta/`) to discover `run_dir` and `summary_file`. Container paths (e.g. `/jaiph/workspace/.jaiph/runs/...`) are remapped to host paths automatically.

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
