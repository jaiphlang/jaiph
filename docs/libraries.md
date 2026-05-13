---
title: Libraries
permalink: /libraries
redirect_from:
  - /libraries.md
---

# Libraries

Workflow systems usually want **shared modules**: reusable rules, scripts, and small packaged workflows. Jaiph does not ship a global library path on the machine. Instead, everything is **scoped to a workspace**: first-party and third-party modules live under disk paths that the compiler resolves from your entry file and **workspace root**.

This page covers **project-scoped libraries** under `<workspace>/.jaiph/libs/`, how `import` resolves into that tree, how **`jaiph install`** populates it from git, and the first-party **`jaiphlang/`** helpers maintained in this repository. For validator behavior and `resolveImportPath`, see [Architecture — Core components](architecture.md#core-components). For exact grammar and export rules, see [Grammar — Imports and Exports](grammar.md#imports-and-exports).

## How imports resolve

Resolution is implemented in `resolveImportPath` (`src/transpile/resolve.ts`). Order:

1. **Relative to the importing file** — `import "./foo"`, `import "../lib/util"` (`.jh` appended when the path omits the extension).
2. **Library fallback** — only if step 1 did not find an existing file **and** the import string contains `/`. The path is split at the first `/` into `<lib-name>` and `<rest>`, then the compiler looks for  
   `<workspace>/.jaiph/libs/<lib-name>/<rest>.jh`  
   (with the same `.jh` defaulting rule as above).

The **workspace root** threaded into **`validateReferences`** / **`emitScriptsForModule`** is whatever root the invoking command computed — for example **`jaiph run`** passes `detectWorkspaceRoot(dirname(entry.jh))`, while **`jaiph install`** uses `detectWorkspaceRoot(process.cwd())`. Detection walks upward from that starting path until `.jaiph` or `.git` (with the temp-directory guards summarized in [CLI — `jaiph install`](cli.md#jaiph-install)). **`jaiph compile`** applies the same resolver over each module’s import closure without emitting scripts (see [Architecture](architecture.md)).

The first segment of a library import is the directory name under `.jaiph/libs/` (for example `queue-lib` in `import "queue-lib/queue"`). If a module declares any `export`, only exported names are visible through the alias — same rule as local modules ([Grammar — Imports and Exports](grammar.md#imports-and-exports)).

**Limitation:** `import script "…"` paths resolve **only** relative to the importing file; there is no library fallback for script imports ([Grammar](grammar.md#imports-and-exports)).

## Installing third-party libraries

```bash
# Clone into .jaiph/libs/<name>/ (shallow git clone) and update the lockfile
jaiph install https://github.com/you/queue-lib.git

# Pin a branch or tag (typical HTTPS shape: …/.git@ref)
jaiph install https://github.com/you/queue-lib.git@v1.0

# Restore all libraries from the lockfile (e.g. after git clone or in CI)
jaiph install
```

`jaiph install` writes `.jaiph/libs.lock` under the workspace root. Commit the lockfile; add `.jaiph/libs/` to `.gitignore` if you do not want vendored clones in version control. If `.jaiph/libs/<name>/` already exists, the clone is skipped unless you pass **`--force`** (see [CLI — `jaiph install`](cli.md#jaiph-install) for URL/`@ref` parsing and lockfile JSON).

The clone directory name is derived from the URL (last path segment, `.git` stripped), so imports use that segment as `<lib-name>`.

## Example: `import` from a clone under `.jaiph/libs/`

After `jaiph install`, paths like `queue-lib/queue` resolve like any other library layout. Exported names come from that repository. Below assumes `.jaiph/libs/jaiphlang/` exists (copy from this repo or install your own package named `jaiphlang`).

```jaiph
import "jaiphlang/queue" as q

workflow default() {
  ensure q.has_tasks()
  const t = run q.get_first_task()
  log "${t}"
}
```

## The `jaiphlang/` standard libraries

The `jaiphlang/` prefix is a **naming convention** for first-party helper modules shipped **in this repository** under `.jaiph/libs/jaiphlang/`. They are not bundled inside the npm `jaiph` package. Copy that directory into your workspace as `.jaiph/libs/jaiphlang/` (or track it in git) so `import "jaiphlang/…"` resolves. They use the same `import` / `export workflow` / `export rule` pattern as any other library.

### `jaiphlang/queue` — `QUEUE.md` task queue

Manages a markdown task file **`QUEUE.md`** at `${JAIPH_WORKSPACE:-.}` (`queue.jh` + `queue.py`). Sections use `##` headers; tags are `#hashtags` on the header line (e.g. `## My task #dev-ready`). **`python3`** must be available on `PATH` when steps run the imported `queue.py` script.

| Export | Kind | Description |
|--------|------|-------------|
| `get_first_task()` | workflow | Returns the first task block (header + body). |
| `next_task(tag)` | workflow | Returns the first task whose header carries the given tag (tag name without `#`). |
| `get_task_by_header(header)` | workflow | Returns a task by title; tags stripped for matching. |
| `get_all_task_headers()` | workflow | Newline-separated task titles (no `##` prefix); all tasks, no tag filter at the Jaiph layer. |
| `mark_task_dev_ready(header)` | workflow | Adds `#dev-ready` to the matching header. |
| `remove_completed_task(header)` | workflow | Removes the task with that title. |
| `set_task_description_from_file(header, bodyPath)` | workflow | Replaces body text from a UTF-8 file; header unchanged. |
| `has_tasks()` | rule | Passes if the queue has at least one task. |
| `task_is_dev_ready(task)` | rule | Passes if the task text has `#dev-ready` on the header line. |
| `all_dev_ready()` | rule | Passes if every task has `#dev-ready`. |

The module also defines a `default` workflow for **direct CLI** use (arguments pass through to the Python helper). Examples:

```bash
jaiph .jaiph/libs/jaiphlang/queue.jh headers
jaiph .jaiph/libs/jaiphlang/queue.jh get dev-ready
jaiph .jaiph/libs/jaiphlang/queue.jh json
```

The Python helper’s `headers` command accepts an optional tag when invoked directly; the exported Jaiph workflow `get_all_task_headers()` does not take parameters and always lists every title.

### `jaiphlang/artifacts` — publishing files out of the sandbox

Copies files from the **workspace** (or sandbox overlay) into the run’s `artifacts/` tree so they remain on the host after Docker teardown or process exit. The runtime sets **`JAIPH_ARTIFACTS_DIR`** to the writable directory for the current run. See [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) and [Sandboxing](sandboxing.md) for the read-only workspace contract in Docker.

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
| `save(paths)` | `paths` is a single file path or a **newline-separated** list of file paths. Blank lines are ignored. Each file is copied to `${JAIPH_ARTIFACTS_DIR}/…` preserving relative layout (`./` stripped; absolute sources use `basename` only). Returns absolute destination path(s), one per line, in order. Exits with failure if the list is empty after trimming, any path is missing, or `JAIPH_ARTIFACTS_DIR` is unset. |

### `jaiphlang/git` — git hygiene helpers and an example commit flow

Small **exported rules** around `git status` / `git rev-parse`, plus **`commit(task)`** / **`default(task)`** workflows that drive an agent-backed prompt to stage and commit changes and write a patch file. This module is **opinionated** (Cursor agent defaults in a `config` block); read `.jaiph/libs/jaiphlang/git.jh` before reusing or trimming it.

| Export | Kind | Description |
|--------|------|-------------|
| `in_git_repo()` | rule | Passes when `git rev-parse --is-inside-work-tree` succeeds (after marking the workspace as a safe directory). |
| `branch_clean()` | rule | Passes when `git status --porcelain` is empty. |
| `has_changes()` | rule | Passes when there are porcelain changes (fails on a clean tree). |
| `is_clean()` | rule | Ensures `in_git_repo()` and `branch_clean()`. |
| `commit(task)` | workflow | Ensures repo + changes, runs a structured `prompt`, writes `git format-patch` output to a `.patch` path, returns that path. |
| `default(task)` | workflow | Delegates to `commit(task)`. |

Use these as patterns for your own libraries: thin `script` wrappers, composable `rule`s, and workflows that call them.
