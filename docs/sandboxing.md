---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Workflows combine shell scripts, agent calls, and inbox routing. That mix makes it easy to depend on mutable global state or to run tools with broader host access than you intended. **Sandboxing** in Jaiph is about narrowing those risks in two **independent** places: how **rules** are meant to be used (language + design), and optionally how the **whole run** is placed (Docker). Both are optional layers in different senses—rules are always subject to grammar constraints; Docker is opt-in.

Execution details below match the **Node workflow runtime** described in [Architecture](../ARCHITECTURE.md): `jaiph run` loads the AST, runs `NodeWorkflowRuntime`, and streams `__JAIPH_EVENT__` on stderr—the same for local and Docker launches.

For general `config` syntax, allowed keys, and precedence with environment variables, see [Configuration](configuration.md). Docker-related keys are documented in detail here.

## Rules: checks, not mutating work

**Rules** are for structured validation: the grammar allows only a subset of step types (`ensure` other rules, `run` scripts, `const`, braced `if`, `fail`, `log` / `logerr`, `return`). There is no raw shell, `prompt`, inbox `send`, and so on. That keeps rule bodies small and reviewable compared to full workflows.

Under **`jaiph run`**, the runtime implements rules by walking the AST **in-process** in Node (`NodeWorkflowRuntime.executeRule` → `executeSteps`). There is **no** extra per-rule OS sandbox: no Linux mount namespace, no automatic read-only filesystem for the rule body.

When a rule runs a **script** step (`run some_script()`), that script is executed as a **normal managed subprocess** (same `spawn`-based path as scripts invoked from workflows): it uses the workspace environment and can read or write any path the process user can access. Design rules accordingly: treat rules as non-mutating checks; perform intentional filesystem changes in **workflows**, not in rules.

Older Bash-oriented materials and compiler golden fixtures referred to Linux **`unshare`** + passwordless **`sudo`** to remount the filesystem read-only around rule bodies. That does **not** apply to the current Node orchestration path for `jaiph run`.

**`jaiph test`** executes tests in-process with `NodeTestRunner`; it does not use Docker or a separate rule sandbox.

## Docker container isolation (optional)

> **Beta.** Docker sandboxing is functional but still under active development. Expect rough edges, breaking changes, and incomplete platform coverage. Feedback is welcome at <https://github.com/jaiphlang/jaiph/issues>.

Docker applies to **`jaiph run` only** (not `jaiph test`). When enabled, the **entire** workflow—including every rule and script step—runs inside one container using the same **Node workflow runtime** as local execution: `node /jaiph/generated/src/runtime/kernel/node-workflow-runner.js` with `.jh` sources and `JAIPH_SCRIPTS` on the workspace mount. Container boundaries apply to the whole run; they do not add a separate per-rule isolation mechanism beyond that.

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
| `runtime.docker_image` | string | `"node:20-bookworm"` | Container image to use (includes Node for the workflow kernel). |
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
    scripts/          # extracted per-step script executables
    src/              # compiled JS source tree (parser, types, transpile, runtime kernel)
      runtime/
        kernel/
          node-workflow-runner.js
          emit.js, inbox.js, prompt.js, run-step-exec.js, …
  workspace/          # the mount targeting /jaiph/workspace (read-write root)
    *.jh              # source files (read by the runner at startup)
    .jaiph/
      runs/
        <YYYY-MM-DD>/
          <HH-MM-SS>-<source-file>/
            000001-<module>__<step>.out
            000002-<module>__<step>.out
            ...
```

- **`/jaiph/generated/`** — Contains the compiled JS source tree (`src/`) and extracted script files (`scripts/`). The container entry is `node /jaiph/generated/src/runtime/kernel/node-workflow-runner.js`, which builds the runtime graph from `.jh` sources in the workspace mount and executes through `NodeWorkflowRuntime` — the same path as local `jaiph run`. Everything under `generated/` is mounted read-only. `JAIPH_SCRIPTS` points to `/jaiph/generated/scripts`.
- **Working directory** — `/jaiph/workspace`.
- **What is shipped** — The compiled JS tree (no TypeScript or `node_modules` in the generated mount) and per-step script executables. No workflow-level `.sh` or `jaiph_stdlib.sh` is required. `.jh` source files are read from the workspace mount.

The CLI also mounts the host directory containing the run meta file read-write at the same path inside the container so the workflow module entrypoint can record exit status and paths (`JAIPH_META_FILE`).

### Docker behavior

- `docker run --rm` with UID/GID mapping (`--user $(id -u):$(id -g)`) on Linux when `id` succeeds; other platforms omit `--user` if mapping is not applied.
- **Structured events** — The `node-workflow-runner` process inside the container writes `__JAIPH_EVENT__` JSON to **stderr only**, the same single event channel used for local runs. The CLI listens on stderr exclusively; stdout carries only plain script output. This is the same contract for all execution modes — the CLI does not parse stdout for events in any mode.
- **`STEP_END` and step logs** — The runtime embeds `out_content` in every `STEP_END` event and `err_content` when the step failed, so consumers do not need host paths to step `.out`/`.err` files (critical in Docker). Payloads are JSON-escaped by the JS emit kernel per RFC 8259 for control characters through `U+001F` plus `\` and `"`. Embedded content is capped at 1 MiB; larger output is truncated with a `[truncated]` marker while full logs remain in `out_file` / `err_file` under the run directory. After a run, failure summaries prefer embedded fields when present and may fall back to reading files for older summaries that predate embedding.
- Docker missing — `E_DOCKER_NOT_FOUND` (no silent fallback).
- Image — If not present locally, `docker pull` is attempted; pull failure → `E_DOCKER_PULL`.
- Timeout — When `runtime.docker_timeout` is greater than zero, overrun kills the container; the CLI may append `E_TIMEOUT container execution exceeded timeout` to captured stderr when the run fails after a timeout.
- Network — `"default"` omits `--network` (Docker’s default bridge). `"none"` passes `--network none`. Any other value is passed through to `docker run --network`.

### Dockerfile-based image detection

The runtime treats the image as **explicitly configured** if **either** `runtime.docker_image` appears in the file (any value) **or** `JAIPH_DOCKER_IMAGE` is set in the environment. In that case `.jaiph/Dockerfile` is **not** consulted.

When the image is **not** explicit (no in-file `runtime.docker_image` and no `JAIPH_DOCKER_IMAGE`):

1. If `.jaiph/Dockerfile` exists in the workspace root, the runtime runs `docker build`, tags the result `jaiph-runtime:latest`, and uses that image.
2. Otherwise it uses the configured image name (default `node:20-bookworm`), pulling if needed.

Build failure → `E_DOCKER_BUILD`.

The repository’s example `.jaiph/Dockerfile` includes:

- **Base image**: `ubuntu:latest`
- **Node.js** — latest LTS from NodeSource (required: the container runs `node-workflow-runner`)
- **Claude Code CLI** — `@anthropic-ai/claude-code`
- **cursor-agent** — installed via Cursor’s distribution, normalized to `/usr/local/bin/cursor-agent` when possible
- **Utilities** — `bash`, `curl`, `git`, `ca-certificates`, `gnupg`

### Agent environment variable forwarding

Besides variables forwarded as part of the normal `JAIPH_*` pass-through (except driver-managed keys like `JAIPH_SCRIPTS` and `JAIPH_META_FILE`), the following prefixes are forwarded for agent authentication and tooling:

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

Minimal workflow with Docker sandbox enabled (adds an extra read-only mount of a `config` directory next to the workflow via the shorthand form):

```jh
config {
  runtime.docker_enabled = true
  runtime.docker_timeout = 600
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:ro"
  ]
}

workflow default {
  log "Running inside Docker"
}
```
