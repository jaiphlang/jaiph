---
title: Libraries
permalink: /libraries
redirect_from:
  - /libraries.md
---

# Libraries

When workflows grow, you want to **reuse** modules: shared rules, script wrappers, and small “standard library” flows. Jaiph does not publish those as a global install path; instead, each **workspace** can hold **project-scoped libraries** under `<workspace>/.jaiph/libs/`. The compiler resolves `import` paths against that tree (after normal relative resolution), and the CLI can **clone** git repositories into that folder and record them in a lockfile. This matches the import story in [Architecture](architecture.md#core-components) (validator + `resolveImportPath` with workspace root).

## How imports resolve

1. **Relative to the current file** — the same as for local modules (`import "./foo"`, `import "../lib/util"`).
2. **Library paths** — if the import string contains a `/` and the relative path does not exist, the compiler tries  
   `<workspace>/.jaiph/libs/<lib-name>/<rest>.jh`  
   (see `resolveImportPath` in the transpiler; the **workspace root** is required everywhere imports are checked).

The library name is the first path segment (e.g. `queue-lib` in `import "queue-lib/queue"`). A module that declares `export` names only exposes those names to importers, as described in [Grammar — Imports and Exports](grammar.md#imports-and-exports).

## Installing third-party libraries

```bash
# Install a library (shallow git clone into .jaiph/libs/<name>/)
jaiph install https://github.com/you/queue-lib.git

# Install a specific tag or branch (ref must follow the .git in the URL)
jaiph install https://github.com/you/queue-lib.git@v1.0

# Restore all libraries from the lockfile (e.g. after git clone)
jaiph install
```

`jaiph install` writes `.jaiph/libs.lock`. Commit the lockfile; add `.jaiph/libs/` to `.gitignore` if you do not want vendored clones in git. Use `--force` to replace an existing clone (see [CLI — `jaiph install`](cli.md#jaiph-install) for details).

## Example: `import` from a clone under `.jaiph/libs/`

`jaiph install` creates `queue-lib/…` on disk, so a path like `queue-lib/queue` resolves the same as any other library layout. The exported names are defined by that repository; here is a self-contained example using the documented **`jaiphlang/queue`** API (after you have `.jaiph/libs/jaiphlang/` in the workspace).

```jaiph
import "jaiphlang/queue" as q

workflow default() {
  ensure q.has_tasks()
  const t = run q.get_first_task()
  log "${t}"
}
```

## The `jaiphlang/` standard libraries

The `jaiphlang/` prefix is a **naming convention** for first-party helper modules (queue, artifacts, …). They are not bundled inside the npm `jaiph` package; the canonical source lives in the [jaiph repository](https://github.com/jaiphlang/jaiph) under `.jaiph/libs/jaiphlang/`. Copy that directory into your own workspace as `.jaiph/libs/jaiphlang/` (or track it in git) so `import "jaiphlang/..."` resolves. They use the same `import` / `export workflow` (and `export rule`) pattern as any other library.

### `jaiphlang/queue` — `QUEUE.md` task queue

Manages a markdown task file **`QUEUE.md`** at `${JAIPH_WORKSPACE:-.}` (see `queue.jh` and `queue.py`). Task sections use `##` headers; optional tags are `#hashtags` on the header line (e.g. `## My task #dev-ready`).

| Export | Kind | Description |
|--------|------|-------------|
| `get_first_task()` | workflow | Returns the first task block (header + body). |
| `next_task(tag)` | workflow | Returns the first task whose header has the given tag. |
| `get_task_by_header(header)` | workflow | Returns a task by title (tags stripped for matching). |
| `get_all_task_headers()` | workflow | Newline-separated task titles (no `##` prefix). |
| `mark_task_dev_ready(header)` | workflow | Adds `#dev-ready` to the matching header. |
| `remove_completed_task(header)` | workflow | Removes the task with that title. |
| `set_task_description_from_file(header, bodyPath)` | workflow | Replaces body text from a UTF-8 file; header unchanged. |
| `has_tasks()` | rule | Passes if the queue has at least one task. |
| `task_is_dev_ready(task)` | rule | Passes if the task text has `#dev-ready` on the header. |
| `all_dev_ready()` | rule | Passes if every task has `#dev-ready`. |

The module also defines a `default` workflow for **direct CLI** use (arguments are forwarded to the Python helper). For example: `jaiph .jaiph/libs/jaiphlang/queue.jh headers`.

### `jaiphlang/artifacts` — publishing files out of the sandbox

Copies files from the **workspace** (or sandbox overlay) into the run’s `artifacts/` tree so they remain on the host after a Docker run or process exit. The kernel sets `JAIPH_ARTIFACTS_DIR` to the writable directory for the current run. See [Architecture](architecture.md#durable-artifact-layout) and [Sandboxing](sandboxing.md) for how that interacts with the read-only workspace in Docker.

```jaiph
import "jaiphlang/artifacts" as artifacts

workflow default() {
  # Single file:
  const path = run artifacts.save("./build/output.bin")

  # Or several files at once — newline-separated list of paths:
  const paths = """
  a.txt
  b/nested.txt
  """
  const dests = run artifacts.save(paths)
}
```

**Exported workflows**

| Workflow | Description |
|----------|-------------|
| `save(paths)` | `paths` is a single file path or a **newline-separated** list of file paths. Each file is copied to `${JAIPH_ARTIFACTS_DIR}/…` using the same relative path (`./` prefix stripped; absolute sources use `basename` only). Returns the absolute destination path(s), one per line, in order. Fails if the list is empty or any file is missing. |
