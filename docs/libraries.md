---
title: Use & publish a library
permalink: /how-to/libraries
diataxis: how-to
redirect_from:
  - /libraries
  - /libraries.md
---

# Use & publish a library

This guide installs a reusable Jaiph library into your workspace, imports it from a program, and (in the second half) publishes a library of your own.

A **Jaiph library** is a git repository with at least one `.jh` module anywhere in the tree. Imports written as `lib-name/path` resolve to `<workspace>/.jaiph/libs/<lib-name>/<path>.jh` after `jaiph install` clones the library into that directory.

## Prerequisites

- Run commands from your project directory. `jaiph install` detects the workspace root from the current directory. It walks up looking for a `.jaiph` or `.git` marker, guards against stray markers in temp directories, and falls back to the starting directory when it finds no marker.
- `git` on `PATH`.

## Part A. Use a library

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

# Install several at once (names and URLs can be mixed)
jaiph install jaiphlang mylib@v1.2 https://github.com/you/queue-lib.git
```

Each argument is resolved independently, so a single command can mix registry names and git URLs, and missing libraries are cloned in parallel. The argument shape decides the path. A token matching `/^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/` with no `/` and no `:` is a **registry name** and is resolved through the index. Everything else is parsed as a **git URL** (optional `@<ref>` suffix for branch or tag).

Registry names install into `.jaiph/libs/<name>/` using the registry key. Git URLs install into `.jaiph/libs/<derived-name>/`, where `<derived-name>` is the last URL path segment without the `.git` suffix. For the same repository, the import prefix from a git URL may differ from the prefix a registry name would give.

`jaiph install` shallow-clones (`git clone --depth 1`) each missing library, removes the nested `.git` directory, and writes a `.jaiph/libs.lock` entry recording the resolved URL, optional version, and the 40-char commit captured before `.git` was removed. Existing directories are skipped unless you pass `--force`. Commit the lockfile.

Remote library URLs must use `https://` or `ssh://`. An `http://` URL, or any other disallowed scheme, is rejected before Jaiph clones anything. When you install by registry name, the registry entry **must** pin the exact commit (and may include a signature). An entry with no pinned `commit` is refused before any clone — pass `--allow-unpinned` to install it anyway after a warning. When the entry pins a commit, the first install checks that the cloned commit matches the pinned one (and, if present, that the signature is valid), and the install fails if either check does not pass. See [CLI — `jaiph install`](cli.md#jaiph-install) for the full list of post-clone checks and their error messages.

### 2. Restore from the lockfile

```bash
jaiph install
```

With no arguments, `jaiph install` restores every entry in `.jaiph/libs.lock`. It clones any missing library directory, and existing directories are skipped unless you pass `--force`. When a lock entry includes a `commit`, the cloned HEAD must match it. On a mismatch the directory is removed and the run fails, reporting the locked SHA and the cloned SHA. Lock entries without `commit` (older lockfiles) restore without that check. The registry is never read on this path.

### 3. Import from a program

The clone directory name is the import prefix. For `jaiph install jaiphlang`, the lib lives at `.jaiph/libs/jaiphlang/` and imports use the `jaiphlang/` prefix:

```jh
import "jaiphlang/queue" as q

export def main() {
  run q.has_tasks()
  const t = run q.get_first_task()
  log "${t}"
}
```

An import whose path has no `/` is looked up only relative to the importing file. The library fallback is skipped for it.

### 4. Verify

```bash
ls .jaiph/libs/jaiphlang/         # cloned files, no nested .git
cat .jaiph/libs.lock              # one entry per installed library
jaiph run ./flow.jh               # imports must resolve at compile time
```

A clone with no `.jh` files anywhere in the tree is rejected with `lib "<name>" contains no .jh modules — not a jaiph library?` and the directory is removed before any lock entry is written.

### Trust boundary for the execution binary

An imported library cannot silently redirect which binary runs your `prompt` steps. The `agent.command` and `agent.backend` config keys set that binary, and Jaiph applies both keys **only** from your entry module's `config {}` block. An imported module that sets either key is ignored for that key. All other config keys (`agent.model`, `agent.trusted_workspace`, `agent.*_flags`, `run.*`) follow the normal cross-module scoping rules. See the [import trust boundary](configuration.md#import-trust-boundary) section of the configuration reference for the full contract and the advanced `JAIPH_AGENT_COMMAND_IMPORT_UNLOCK` and `JAIPH_AGENT_BACKEND_IMPORT_UNLOCK` opt-in.

## Part B. Publish a library

Publishing uses plain git. There is no package registry upload and no build step.

### 1. Lay out the repo

A library is a git repository of `.jh` modules plus any companion script files those modules reference. Libraries commonly take one of these shapes:

- **Single-file lib.** `repo-root/queue.jh`, imported as `"queue-lib/queue"` when installed as `queue-lib`.
- **Multi-module lib.** Several `.jh` files (at the repo root or in subdirectories), each imported as `"<install-name>/<path>"` without the `.jh` suffix (for example `"mylib/subdir/helper"` for `subdir/helper.jh`).

Companion scripts (e.g. `queue.py` next to `queue.jh`) must be referenced with **relative paths**, such as `import script "./queue.py"`. The `import script` statement resolves the path only relative to the importing file, so it has no fallback to the workspace libraries directory.

### 2. Decide the public surface

Add `export` to the defs and scripts you want importers to see:

```jh
export def get_first_task() { … }
export def has_tasks() { … }
```

A module with **zero** `export` lines exposes nothing through the import alias. Names are private by default; importers can only call exported names.

### 3. Tag a release

```bash
git tag v0.1.0
git push --tags
```

Consumers pin to that tag with `jaiph install <name>@v0.1.0` or `jaiph install <url>.git@v0.1.0`. The ref is passed straight to `git clone --branch`. The resolved 40-char commit is recorded in `.jaiph/libs.lock`, so restore is reproducible even when the tag later moves.

### 4. (Optional) List on `jaiph.org/registry`

To let consumers install by bare name, open a PR against [`jaiphlang/registry`](https://github.com/jaiphlang/registry) adding an entry to `registry.json` under a unique key matching `/^[A-Za-z0-9_-]+$/`:

```json
{
  "libs": {
    "<your-name>": {
      "url": "https://github.com/<you>/<repo>.git",
      "description": "<one line>",
      "commit": "<40-char hex SHA>"
    }
  }
}
```

An entry **must** pin a `commit` (a 40-character hex SHA) and may include a detached minisign `signature` over that commit SHA. Jaiph verifies that signature only against its own embedded project key (`jaiph.pub`), never against a key supplied by the entry, so an entry cannot vouch for its own signature. `npm run registry:build` refuses to write an index whose entries are not all pinned, so shipped entries always carry a `commit`; consumers installing an unpinned entry must pass `--allow-unpinned`. When these fields are present, `jaiph install` checks the cloned commit against the pinned `commit` and verifies the `signature`, and it fails the install if either check does not pass.

The key is the import prefix consumers will write (`import "<your-name>/…"`). After the PR merges upstream, maintainers of the Jaiph repo run `npm run registry:build`, sign the built index with minisign so that `docs/registry.minisig` is committed beside `docs/registry`, and push. GitHub Pages then serves both files, the index at `https://jaiph.org/registry` and its signature at `https://jaiph.org/registry.minisig`. A remote `jaiph install` verifies the index against that signature and fails closed when the signature is missing or does not match, so publishing `docs/registry.minisig` is required for remote installs to work. See [Contributing — Library registry signing](contributing.md#library-registry-signing).

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
- [Save artifacts](artifacts.md) — the `jaiphlang/artifacts` library covered there is one example consumer.
