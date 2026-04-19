---
title: Sandboxing
permalink: /sandboxing
redirect_from:
  - /sandboxing.md
---

# Sandboxing

Jaiph provides two ways to limit what a workflow can do. **`run readonly`** restricts step types at the language level so validation logic stays small and reviewable. **`run isolated`** spawns a per-call Docker container for OS-level filesystem and process isolation. You can use either mechanism on its own or combine them.

All runs use the same Node workflow runtime and stream `__JAIPH_EVENT__` on stderr. [Hooks](hooks.md) always run on the host CLI and consume that same event stream. For `config` syntax, allowed keys, and precedence rules, see [Configuration](configuration.md). For the full step-type matrix, see [Grammar](grammar.md).

## `run readonly`: structured validation, not mutation

`run readonly ref()` executes a workflow in a read-only context. Inside a `readonly` call, the permitted step set is restricted: `run` (scripts and workflows), `const` (script/workflow captures or bash RHS, not `prompt`), `match`, `fail`, `log` / `logerr`, `return`, and `run … catch`. Raw shell, `prompt`, `send` / `route`, and `run async` are disallowed. See [Grammar — High-level concepts](grammar.md#high-level-concepts) for the authoritative list.

The runtime executes readonly workflow bodies by walking the AST in-process. There is no per-call OS sandbox — no mount namespace, no automatic read-only filesystem. When a readonly workflow runs a script step, that script executes as a normal managed subprocess with full access to paths the process user can reach. Treat readonly workflows as non-mutating checks by convention; perform intentional filesystem changes in unrestricted workflows.

`jaiph test` executes tests in-process with `NodeTestRunner` and does not use Docker or a separate readonly sandbox.

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

The container image defaults to the official GHCR image (`ghcr.io/jaiphlang/jaiph-runtime:<version>`). Override with `JAIPH_ISOLATED_IMAGE` for custom images. `JAIPH_DOCKER_NETWORK` and `JAIPH_DOCKER_TIMEOUT` tune network mode and timeout for isolated containers (see [Configuration — Isolated execution keys](configuration.md#isolated-execution-keys-host-level-only)).

### Nested isolation is forbidden

`run isolated` inside an already-isolated context is a compile-time error. The compiler walks the static call graph: if `run isolated A()` is written and `A` transitively reaches another `run isolated`, the program is rejected. A runtime guard (`JAIPH_ISOLATED=1` sentinel) provides defense-in-depth.

### Host requirements

- Docker daemon running (`docker info` must succeed)
- fuse-overlayfs installed in the container image (included in the official image)
- `/dev/fuse` available to the Docker VM

If any requirement is missing, `run isolated` fails with an actionable error message.

For the formal specification, see [Spec: Handle, Isolation, and Recover Composition](spec-async-isolated.md).
