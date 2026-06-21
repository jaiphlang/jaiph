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

A **Jaiph library is a public git repository** containing at least one `.jh` module anywhere in the tree. Imports written as `lib-name/path` resolve to `<workspace>/.jaiph/libs/<lib-name>/<path>.jh` after `jaiph install` clones the library into that directory.

## Prerequisites

- Run commands from your project directory. `jaiph install` detects the workspace root from the current directory (walks up for `.jaiph` or `.git`, with temp-directory guards; if no marker is found, the starting directory is used).
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

The argument shape decides the path. A token matching `/^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/` with no `/` and no `:` is a **registry name** and is resolved through the index. Everything else is parsed as a **git URL** (optional `@<ref>` suffix for branch or tag).

Registry names install into `.jaiph/libs/<name>/` using the registry key. Git URLs install into `.jaiph/libs/<derived-name>/`, where `<derived-name>` is the last URL path segment without the `.git` suffix — the import prefix may differ from a registry name for the same repository.

`jaiph install` shallow-clones (`git clone --depth 1`) each missing library, removes the nested `.git` directory, and writes a `.jaiph/libs.lock` entry recording the resolved URL, optional version, and the 40-char commit captured before `.git` was removed. Existing directories are skipped unless you pass `--force`. Commit the lockfile.

### 2. Restore from the lockfile

```bash
jaiph install
```

With no arguments, `jaiph install` restores every entry in `.jaiph/libs.lock`: it clones any missing library directory (existing directories are skipped unless you pass `--force`). When a lock entry includes a `commit`, the cloned HEAD must match it; on mismatch the directory is removed and the run fails with the locked vs cloned SHAs. Lock entries without `commit` (older lockfiles) restore without that check. The registry is never read on this path.

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

Imports without `/` only attempt relative-to-file lookup; the library fallback is skipped.

### 4. Verify

```bash
ls .jaiph/libs/jaiphlang/         # cloned files, no nested .git
cat .jaiph/libs.lock              # one entry per installed library
jaiph run ./flow.jh               # imports must resolve at compile time
```

A clone with no `.jh` files anywhere in the tree is rejected with `lib "<name>" contains no .jh modules — not a jaiph library?` and the directory is removed before any lock entry is written.

## Part B — Publish a library

Publishing is git-native — no package registry upload, no build step.

### 1. Lay out the repo

A library is a git repository of `.jh` modules plus any companion script files those modules reference. Two common shapes:

- **Single-file lib** — `repo-root/queue.jh`, imported as `"queue-lib/queue"` when installed as `queue-lib`.
- **Multi-module lib** — several `.jh` files (at the repo root or in subdirectories), each imported as `"<install-name>/<path>"` without the `.jh` suffix (for example `"mylib/subdir/helper"` for `subdir/helper.jh`).

Companion scripts (e.g. `queue.py` next to `queue.jh`) must be referenced with **relative paths** — `import script "./queue.py"` — because `import script` has no workspace-libs fallback.

### 2. Decide the public surface

Add `export` to the workflows, rules, and scripts you want importers to see:

```jh
export workflow get_first_task() { … }
export rule has_tasks() { … }
```

A module with **zero** `export` lines exposes every top-level rule, workflow, and script through the import alias. Prefer explicit `export` on published libraries so removing a private helper does not break consumers.

### 3. Tag a release

```bash
git tag v0.1.0
git push --tags
```

Consumers pin to that tag with `jaiph install <name>@v0.1.0` or `jaiph install <url>.git@v0.1.0`. The ref is passed straight to `git clone --branch`; the resolved 40-char commit is recorded in `.jaiph/libs.lock` so restore is reproducible even when the tag later moves.

### 4. (Optional) List on `jaiph.org/registry`

To let consumers install by bare name, open a PR against [`jaiphlang/registry`](https://github.com/jaiphlang/registry) adding an entry to `registry.json` under a unique key matching `/^[A-Za-z0-9_-]+$/`:

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

The key is the import prefix consumers will write (`import "<your-name>/…"`). After the PR merges upstream, maintainers of the Jaiph repo run `npm run registry:build`, commit the updated `docs/registry`, and push — GitHub Pages then serves the index at `https://jaiph.org/registry`.

## Verification

For a consumer:

- `.jaiph/libs/<name>/` exists with the expected `.jh` modules.
- `jaiph run ./flow.jh` compiles without `E_IMPORT_NOT_FOUND`.
- `.jaiph/libs.lock` records the resolved URL and commit.

For a publisher:

- A fresh clone of your lib by URL (`jaiph install <url>.git@<tag>`) resolves and runs.
- Removing an unexported private name does not break consumers when the module uses explicit `export` lines (only exported names are reachable).

## Related

- [Architecture — Local module graph](architecture.md#local-module-graph) — how `<lib>/<path>` imports resolve through `.jaiph/libs/`.
- [Save artifacts](/how-to/artifacts) — the `jaiphlang/artifacts` library covered there is one example consumer.
