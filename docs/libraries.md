---
title: Libraries
permalink: /libraries
redirect_from:
  - /libraries.md
---

# Libraries

## Why workspaces and `.jaiph/libs`

Workflow authoring usually needs **shared modules**: reusable rules, scripts, and small packaged workflows people can version and reuse across projects.

Jaiph avoids a machine-wide library path: resolution is anchored to a **workspace** (detected directory root; see below). Modules you own live next to your entry `.jh`; **third-party clones** conventionally live under **`<workspace>/.jaiph/libs/<name>/`**, wired up by **`jaiph install`**. Imports that look like **`lib-name/rest/of/path`** attach to those directories when relative resolution misses.

This page covers that layout, **`import`** resolution (**`resolveImportPath`** in `src/transpile/resolve.ts`), **`jaiph install`**, and the first-party **`jaiphlang/`** helpers shipped in **this repo** under `.jaiph/libs/jaiphlang/`. Validator behavior crosses into [Architecture — Core components](architecture.md#core-components). Grammar for import/export syntax lives in [Grammar — Imports and Exports](grammar.md#imports-and-exports).

## How imports resolve

Resolution runs in **`resolveImportPath`** — order:

1. **Relative to the importing file** — e.g. `import "./foo"`, `import "../lib/util"`. Paths without a `.jh` suffix get **`.jh`** appended automatically.
2. **Library fallback** — only if step 1’s candidate path **does not exist on disk**, **`workspaceRoot`** is set, **and** the import string **`contains`** a **`/`**. The first `/` splits **`lib-name`** from **`rest`**, then the compiler looks for **`<workspace>/.jaiph/libs/<lib-name>/<rest>.jh`** (same extension defaulting).

Implications:

- **Imports without `/`** — e.g. **`import "submod"`** — only relative-to-file lookup is attempted; there is **no** library fallback under `.jaiph/libs/` even if a matching folder name exists.
- **`jaiph compile`** runs the same **`validateReferences`** check as **`jaiph run`** but does not emit **`scripts/`** or invoke **`buildRuntimeGraph()`** ([Architecture — Summary](architecture.md#summary)).

**Workspace root:** whatever the invoking CLI path passes into **`emitScriptsForModule`** / **`validateReferences`**:

- **`jaiph run`** and **`jaiph test`** on an explicit **`*.jh` / `*.test.jh`** file use **`detectWorkspaceRoot(dirname(entry))`** (same predicate for both commands).
- **`jaiph test`** with **no** file argument discovers tests under **`detectWorkspaceRoot(process.cwd())`** (`src/cli/commands/test.ts`).
- **`jaiph install`** uses **`detectWorkspaceRoot(process.cwd())`**.
- **`jaiph compile`** uses **`detectWorkspaceRoot(dirname(file))`** per validated module by default, or **`--workspace <dir>`** to pin one root for the whole command (`src/cli/commands/compile.ts`).

Walk-up rules (`.jaiph` / `.git` markers, temp-directory guards) match [CLI — `jaiph install`](cli.md#jaiph-install).

**Export visibility:** if an imported module declares **any** `export`, only those names are valid through the alias; otherwise **every** top-level workflow, rule, and script in that file is reachable ([Architecture — Core components](architecture.md#core-components)). First-party **`jaiphlang/*`** modules typically use explicit `export` lines; **`jaiphlang/git`** is the odd one out (see below).

**Limitation:** **`import script "…"`** paths are validated with **`resolveScriptImportPath`**: **only** relative to the importing file’s directory — **no** workspace library fallback (`src/transpile/validate.ts`).

## Installing third-party libraries

```bash
# Clone into .jaiph/libs/<name>/ (shallow git clone) and update the lockfile
jaiph install https://github.com/you/queue-lib.git

# Pin a branch or tag (common shape: …/.git@ref — passed to git clone --branch)
jaiph install https://github.com/you/queue-lib.git@v1.0

# Restore all libraries from the lockfile (e.g. after git clone or in CI)
jaiph install
```

`jaiph install` writes **`.jaiph/libs.lock`** under the workspace root. Commit the lockfile; add **`.jaiph/libs/`** to `.gitignore` if you do not want vendored clones in version control. If **`.jaiph/libs/<name>/`** already exists, the clone is skipped unless you pass **`--force`** (URL / `@ref` parsing: [CLI — `jaiph install`](cli.md#jaiph-install)).

The clone directory name is **`deriveLibName(url)`** (last path segment, **`.git`** stripped), so imports use that segment as **`lib-name`**.

## Example: `import` from a clone under `.jaiph/libs/`

After `jaiph install`, paths like **`queue-lib/queue`** resolve like any other library layout. Below assumes **`.jaiph/libs/jaiphlang/`** exists (copy from this repo or install a repo whose root name is **`jaiphlang`**).

```jaiph
import "jaiphlang/queue" as q

workflow default() {
  ensure q.has_tasks()
  const t = run q.get_first_task()
  log "${t}"
}
```

## The `jaiphlang/` standard libraries

The **`jaiphlang/`** prefix is a **naming convention** for first-party helper modules maintained **in this repository** under **`.jaiph/libs/jaiphlang/`**. They are **not** bundled inside the published npm **`jaiph`** package; copy that tree into your workspace or track it in git so **`import "jaiphlang/…"`** resolves. They use the same **`import` / `export workflow` / `export rule`** pattern as any other library (except **`git`**, see below).

### `jaiphlang/queue` — `QUEUE.md` task queue

Manages a markdown task file **`QUEUE.md`** at **`${JAIPH_WORKSPACE:-.}`** (`queue.jh` + `queue.py`). Sections use **`##`** headers; tags are **`#hashtags`** on the header line (e.g. **`## My task #dev-ready`**). **`python3`** must be on **`PATH`** when steps run the imported **`queue.py`** script.

| Symbol | Kind | Description |
|--------|------|-------------|
| `get_first_task()` | workflow | Returns the first task block (header + body) via **`queue("get")`**. |
| `next_task(tag)` | workflow | Returns the first task whose header carries the given tag (tag name without `#`). |
| `get_task_by_header(header)` | workflow | Returns a task by title; tags stripped for matching. |
| `get_all_task_headers()` | workflow | Newline-separated task titles (no `##` prefix); calls **`queue("headers")`** with no extra args, so **all** tasks are listed (the Python **`headers`** subcommand accepts an optional tag when run directly from the CLI, but this workflow does not expose that). |
| `mark_task_dev_ready(header)` | workflow | Adds **`#dev-ready`** to the matching header. |
| `remove_completed_task(header)` | workflow | Removes the task with that title. |
| `set_task_description_from_file(header, bodyPath)` | workflow | Replaces body text from a UTF-8 file; header unchanged. |
| `has_tasks()` | rule | Passes if the queue has at least one task. |
| `task_is_dev_ready(task)` | rule | Passes if the task text has **`#dev-ready`** on the header line. |
| `all_dev_ready()` | rule | Passes if every task has **`#dev-ready`**. |

The module also defines a **`default`** workflow for **direct CLI** use (arguments pass through to the Python helper). Examples:

```bash
jaiph .jaiph/libs/jaiphlang/queue.jh headers
jaiph .jaiph/libs/jaiphlang/queue.jh get dev-ready
jaiph .jaiph/libs/jaiphlang/queue.jh json
```

### `jaiphlang/artifacts` — publishing files out of the sandbox

Copies files from the **workspace** (or sandbox overlay) into the run’s **`artifacts/`** tree so they remain on the host after Docker teardown or process exit. The runtime sets **`JAIPH_ARTIFACTS_DIR`** to the writable directory for the current run. See [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) and [Sandboxing](sandboxing.md) for the read-only workspace contract in Docker.

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

**Exported workflow**

| Workflow | Description |
|----------|-------------|
| `save(paths)` | **`paths`** is a single file path or a **newline-separated** list of file paths. Blank lines are ignored. Each file is copied to **`${JAIPH_ARTIFACTS_DIR}/…`** preserving relative layout (`./` stripped; absolute sources use **`basename`** only). Returns absolute destination path(s), one per line, in order. Exits with failure if the list is empty after trimming, any path is missing, or **`JAIPH_ARTIFACTS_DIR`** is unset. |

### `jaiphlang/git` — git hygiene helpers and an example commit flow

**`git.jh`** defines rules and workflows **without** **`export`** keywords. With **zero** `export` lines, the compiler does **not** hide any top-level names: importers may reference **every** **`rule`** and **`workflow`** in that file. Prefer explicit **`export`** in libraries you publish so only a stable surface is reachable.

The module mixes small rules around **`git status`** / **`git rev-parse`** with **`commit(task)`** / **`default(task)`** workflows that drive a **`prompt`** to stage/commit and write **`git format-patch -1 HEAD --stdout`** to a **`*.patch`** path. This file is **opinionated** (default **`config`** block targets the Cursor agent); read **`.jaiph/libs/jaiphlang/git.jh`** before trimming or reusing.

| Symbol | Kind | Description |
|--------|------|-------------|
| `in_git_repo()` | rule | Passes when **`git rev-parse --is-inside-work-tree`** succeeds (after marking the workspace as a safe directory). |
| `branch_clean()` | rule | Passes when **`git status --porcelain`** is empty. |
| `has_changes()` | rule | Passes when there are porcelain changes (fails on a clean tree). |
| `is_clean()` | rule | Passes when **`in_git_repo()`** **and** **`branch_clean()`** both pass (their **`ensure`** calls are inlined in this rule). |
| `commit(task)` | workflow | Ensures repo + changes, runs **`prompt`**, writes patch file, returns path. |
| `default(task)` | workflow | Runs **`commit(task)`** (same **`return`**). |

Use **`jaiphlang`** modules as patterns for your own libs: thin **`script`** wrappers, composable **`rule`** constructs, and workflows built on both.
