---
title: Use & publish a library
permalink: /how-to/libraries
diataxis: how-to
redirect_from:
  - /libraries
  - /libraries.md
---

# Use & publish a library

This recipe installs a reusable Jaiph library into your workspace, imports it from a workflow, and (in the second half) publishes a library of your own.

A **Jaiph library is a public git repository** with one or more `.jh` modules at the root. Imports written as `lib-name/path` resolve to `<workspace>/.jaiph/libs/<lib-name>/<path>.jh` after `jaiph install` clones the library into that directory.

## Prerequisites

- A workspace root with a `.jaiph` or `.git` marker (so `detectWorkspaceRoot` finds it).
- `git` on `PATH`.

## Part A — Use a library

### 1. Install by name or URL

```bash
# Resolve a registry name (uses JAIPH_REGISTRY, default https://jaiph.org/registry)
jaiph install jaiphlang

# Pin a registry name to a version
jaiph install mylib@v1.2

# Clone a git URL directly into .jaiph/libs/<name>/
jaiph install https://github.com/you/queue-lib.git

# Pin a branch or tag
jaiph install https://github.com/you/queue-lib.git@v1.0
```

The argument shape decides the path. A token matching `/^[A-Za-z0-9_-]+(@…)?$/` with no `/` and no `:` is a **registry name** and is resolved through the index. Everything else is parsed as a **git URL**.

`jaiph install` clones each missing library, removes the nested `.git` directory, and writes a `.jaiph/libs.lock` entry recording the resolved URL, version, and the 40-char commit captured before `.git` was removed. Commit the lockfile.

### 2. Restore from the lockfile

```bash
jaiph install
```

With no arguments, `jaiph install` re-clones every entry in `.jaiph/libs.lock`, verifies the commit matches what is recorded, and fails with a deterministic error if a tag has moved. The registry is never read on this path.

### 3. Import from a workflow

The clone directory name is the import prefix. For `jaiph install jaiphlang`, the lib lives at `.jaiph/libs/jaiphlang/` and imports use the `jaiphlang/` prefix:

```jh
import "jaiphlang/queue" as q

workflow default() {
  ensure q.has_tasks()
  const t = run q.get_first_task()
  log "${t}"
}
```

Imports without `/` only attempt relative-to-file lookup; the library fallback is skipped. Pass any flags or arguments the imported workflow expects.

### 4. Verify

```bash
ls .jaiph/libs/jaiphlang/         # cloned files, no nested .git
cat .jaiph/libs.lock              # one entry per installed library
jaiph run ./flow.jh               # imports must resolve at compile time
```

A clone with no `.jh` modules is rejected with `lib "<name>" contains no .jh modules — not a jaiph library?` and the directory is removed before any lock entry is written.

## Part B — Publish a library

Publishing is git-native — no package registry upload, no build step.

### 1. Lay out the repo

A library is a directory of top-level `.jh` modules plus any companion script files those modules reference. Two common shapes:

- **Single-file lib** — `repo-root/queue.jh`, imported as `"queue-lib/queue"`.
- **Multi-module lib** — several `.jh` files at the repo root, imported individually under the same prefix.

Companion scripts (e.g. `queue.py` next to `queue.jh`) must be referenced with **relative paths** — `import script "./queue.py"` — because `import script` has no workspace-libs fallback.

### 2. Decide the public surface

Add `export` to the workflows, rules, and scripts you want importers to see:

```jh
export workflow get_first_task() { … }
export rule has_tasks() { … }
```

A module with **zero** `export` lines exposes every top-level name through the importer's alias. Prefer explicit `export` on published libraries so removing a private helper does not break consumers.

### 3. Tag a release

```bash
git tag v0.1.0
git push --tags
```

Consumers pin to that tag with `jaiph install <name>@v0.1.0` or `jaiph install <url>.git@v0.1.0`. The ref is passed straight to `git clone --branch`; the resolved 40-char commit is recorded in `.jaiph/libs.lock` so restore is reproducible even when the tag later moves.

### 4. (Optional) List on `jaiph.org/registry`

To let consumers install by bare name, open a PR against [`jaiphlang/registry`](https://github.com/jaiphlang/registry) adding an entry under a unique key matching `/^[A-Za-z0-9_-]+$/`:

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

The key is the import prefix consumers will write (`import "<your-name>/…"`). The PR maintainers regenerate `docs/registry` and GitHub Pages redeploys; the new entry is live at the next release.

## Verification

For a consumer:

- `.jaiph/libs/<name>/` exists with the expected `.jh` modules.
- `jaiph run ./flow.jh` compiles without `E_IMPORT_NOT_FOUND`.
- `.jaiph/libs.lock` records the resolved URL and commit.

For a publisher:

- A fresh clone of your lib by URL (`jaiph install <url>.git@<tag>`) resolves and runs.
- Removing an unexported private name from your library does not break consumers (because they only see exports).

## Related

- [Architecture — Core components](architecture.md#core-components) — how the import closure and library fallback are resolved.
- [Save artifacts](/how-to/artifacts) — the `jaiphlang/artifacts` library covered there is one example consumer.
