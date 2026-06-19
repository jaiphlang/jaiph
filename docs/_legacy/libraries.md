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

**Workspace root:** whatever the invoking CLI path passes into **`loadModuleGraph`** (the single discovery routine consumed by **`validateReferences`** / **`emitScriptsForModuleFromGraph`**):

- **`jaiph run`** and **`jaiph test`** on an explicit **`*.jh` / `*.test.jh`** file use **`detectWorkspaceRoot(dirname(entry))`** (same predicate for both commands).
- **`jaiph test`** with **no** file argument discovers tests under **`detectWorkspaceRoot(process.cwd())`** (`src/cli/commands/test.ts`).
- **`jaiph install`** uses **`detectWorkspaceRoot(process.cwd())`**.
- **`jaiph compile`** uses **`detectWorkspaceRoot(dirname(file))`** per validated module by default, or **`--workspace <dir>`** to pin one root for the whole command (`src/cli/commands/compile.ts`).

Walk-up rules (`.jaiph` / `.git` markers, temp-directory guards) match [CLI — `jaiph install`](cli.md#jaiph-install).

**Export visibility:** if an imported module declares **any** `export`, only those names are valid through the alias; otherwise **every** top-level workflow, rule, and script in that file is reachable ([Architecture — Core components](architecture.md#core-components)). First-party **`jaiphlang/*`** modules typically use explicit `export` lines; **`jaiphlang/git`** is the odd one out (see below).

**Limitation:** **`import script "…"`** paths are validated with **`resolveScriptImportPath`**: **only** relative to the importing file’s directory — **no** workspace library fallback (`src/transpile/validate.ts`).

## Installing third-party libraries

```bash
# Install by registry name (uses JAIPH_REGISTRY env var, else https://jaiph.org/registry)
jaiph install jaiphlang

# Pin a registry name to a version
jaiph install mylib@v1.2

# Clone a git URL directly (no registry lookup) into .jaiph/libs/<name>/
jaiph install https://github.com/you/queue-lib.git

# Pin a branch or tag (URL form: …/.git@ref — passed to git clone --branch)
jaiph install https://github.com/you/queue-lib.git@v1.0

# Restore all libraries from the lockfile (e.g. after git clone or in CI)
jaiph install
```

**Argument shape decides the path.** A positional arg matching `/^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/` with **no `/` and no `:`** is treated as a **registry name** and resolved through the registry index (`JAIPH_REGISTRY`, default `https://jaiph.org/registry`); everything else is parsed as a **git URL** with optional trailing `@ref`. See [CLI — `jaiph install`](cli.md#jaiph-install) for the index format, source resolution, and error messages.

`jaiph install` writes **`.jaiph/libs.lock`** under the workspace root. Commit the lockfile; add **`.jaiph/libs/`** to `.gitignore` if you do not want vendored clones in version control. If **`.jaiph/libs/<name>/`** already exists, the clone is skipped without invoking `git` unless you pass **`--force`**.

**Installed libs are plain files, not nested git repos.** After cloning, the CLI deletes `.jaiph/libs/<name>/.git` so the lib lives as ordinary files inside your workspace — no nested repo, no `git status` noise, no submodule-like surprises. The lockfile is the source of truth for "what was cloned": each entry records the 40-char `commit` captured before `.git` was removed, so restore can verify the same commit was retrieved later. The CLI also rejects clones with no `*.jh` modules — `jaiph install <something-that-is-not-a-jaiph-library>` removes the directory and fails with `lib "<name>" contains no .jh modules — not a jaiph library?` instead of writing a lock entry for it. See [CLI — `jaiph install`](cli.md#jaiph-install) for the full hygiene contract, including the **commit-mismatch error** restore raises when a tag has moved underneath the lockfile.

Missing libraries are cloned **concurrently** (default 4 in flight), so restoring or installing several repositories at once does not pay full network/process latency one repo at a time. Failed clones still exit the command non-zero and do not produce a lock entry. Restore-from-lock (`jaiph install` with no args) does not invent new lock entries and **never reads the registry** — the lock entry already carries the resolved clone URL. See [CLI — `jaiph install`](cli.md#jaiph-install) for the full contract.

The clone directory name **is the import prefix**. For **registry-name** installs it is the registry key itself, regardless of the repo's URL — so an entry like `{ "mylib": { "url": "https://example.com/some-other-repo-name.git", … } }` installs into `.jaiph/libs/mylib/` and is imported as `import "mylib/…"`. For **git-URL** installs the name is **`deriveLibName(url)`** (last path segment, **`.git`** stripped) — so the URL's last segment **must** match the import prefix the lib uses.

## Publishing a library

A **Jaiph library is a public git repository**. There is no build step, no package registry upload — to publish a library you push a git repo, tag a release, and (optionally) open a PR adding an entry to the index.

**Repo layout.** A library is a directory of top-level **`.jh`** modules plus any companion files the modules need to execute. Importers reach a module as **`<lib-name>/<module>`** (the **`.jh`** is appended automatically; see [How imports resolve](#how-imports-resolve)). Two common patterns:

- A single-file lib — e.g. `repo-root/queue.jh` — imported as **`import "queue-lib/queue"`**.
- A multi-module lib — several `.jh` files at the repo root, imported individually under the same lib prefix.

**Export visibility.** Each module decides its public surface with **`export`**. With zero `export` lines every top-level **`workflow`**, **`rule`**, and **`script`** in that module is reachable through the importer's alias; with one or more `export` lines only the exported names are reachable ([Architecture — Core components](architecture.md#core-components)). Prefer explicit `export` on published libraries so the surface stays stable across releases.

**Companion scripts.** Library `.jh` modules typically wrap small helper scripts that ship in the same repo — for example **`.jaiph/libs/jaiphlang/queue.jh`** imports a sibling **`queue.py`** that holds the markdown-parsing logic. Imported **`script`** paths are resolved **relative to the importing `.jh` file** with no workspace fallback (see the **Limitation** note above), so place companion scripts next to the modules that use them and reference them with relative paths (`script ./queue.py …` or `import script "./queue.py"`).

**Versioning is git-native.** Tag releases with **`git tag v0.1.0 && git push --tags`**. Consumers pin to a tag, branch, or commit through the `jaiph install` `@ref` suffix — for example **`jaiph install jaiphlang@v0.1.0`** (registry name) or **`jaiph install https://github.com/you/queue-lib.git@v0.1.0`** (URL). The ref is passed straight to `git clone --branch`, and the resolved 40-char commit is recorded in `.jaiph/libs.lock` so restore is reproducible even when the tag later moves (see [CLI — `jaiph install`](cli.md#jaiph-install)).

**Publishing flow.** To list a library on **`jaiph.org/registry`** so consumers can install it by bare name:

1. Push the lib to a **public** git repo with at least one `.jh` module at the root.
2. Tag a release (`git tag v0.1.0 && git push --tags`) so consumers have something stable to pin.
3. Open a PR against **[`jaiphlang/registry`](https://github.com/jaiphlang/registry)** adding an entry to **`registry.json`** under a unique key matching `/^[A-Za-z0-9_-]+$/`:
   ```json
   {
     "libs": {
       "<your-name>": {
         "url": "https://github.com/<you>/<repo>.git",
         "description": "<one line>"
       }
     }
   }
   ```
   The key is the import prefix — pick it carefully; consumers will write `import "<your-name>/…"`.
4. Once a maintainer of this repo merges the registry PR and runs **`npm run registry:build`**, the regenerated `docs/registry` is committed and GitHub Pages redeploys jaiph.org. The new entry is live at the latest with the next release.

For the index format, error messages, and the `JAIPH_REGISTRY` source-resolution rules, see [CLI — `jaiph install` — Registry](cli.md#registry).

## Lockfile semantics

`jaiph install` writes **`.jaiph/libs.lock`** under the workspace root. Each entry records the resolved clone **`url`**, the optional requested **`version`** (tag / branch / ref), and the optional 40-char **`commit`** captured immediately after clone (before `.git` is stripped). Commit the lockfile; **restore-from-lock** (`jaiph install` with no args) re-clones at `version` and **fails** if the cloned HEAD does not match the recorded `commit` — so a tag that moves underneath you produces a deterministic error instead of a silent upgrade. Lock entries written by older CLIs without the `commit` field still restore — the verification simply skips when the field is absent. See [CLI — `jaiph install` — Lockfile](cli.md#lockfile) for the file shape, the commit-mismatch error, and the backward-compatibility contract.

## Overriding the registry source

The default registry source is **`https://jaiph.org/registry`**. Set **`JAIPH_REGISTRY`** to a file path, a `file://` URL, or any other URL to override it — useful for unit tests, air-gapped setups, mirrors, or staging a registry PR locally:

```bash
JAIPH_REGISTRY=./registry.json jaiph install mylib
JAIPH_REGISTRY=https://internal.example.com/registry jaiph install mylib
```

The registry is only contacted when at least one positional arg is a bare name; URL-form installs and restore-from-lock never read it ([CLI — `jaiph install` — Registry](cli.md#registry)).

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
