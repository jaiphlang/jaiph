---
title: Setup
permalink: /setup
redirect_from:
  - /setup.md
---

# Setup

## Overview

Jaiph ships as a **CLI** backed by Node: it parses `.jh` sources, runs compile-time validation during script extraction, emits **`script`** bodies into a **`scripts/`** directory (path in **`JAIPH_SCRIPTS`**), and starts a **Node workflow runtime** that interprets workflow ASTs in process (same stack for local runs, Docker, and tests — see [Architecture — System overview](architecture.md#system-overview)). This page covers **installing the CLI**, **running your first workflow**, **workspace layout**, and **`jaiph init`**, not language syntax or runtime internals.

Goals you should leave with:

1. **The Jaiph CLI** on your `PATH`.
2. A mental model for **workspace root** (`JAIPH_WORKSPACE`), **run artifacts**, and optional **`.jaiph/`** scaffolding.
3. Pointers to **format**, **tests**, **libraries**, and deeper docs.

### Prerequisites

- **`curl`** and **`shasum`** / **`sha256sum`** — the only host requirements for the curl installer. It downloads a pre-built standalone binary from the matching GitHub Release and verifies the checksum before installing. **Node and npm are not required to run `jaiph`** (the binary is self-contained — see [Architecture — Distribution](architecture.md#distribution-node-vs-bun-standalone)). Contributors building from source need Bun and npm instead — see [Contributing — Installing from source](contributing.md#installing-from-source).
- **Shell tooling** — **emitted `script` steps** run by spawning the script path so the interpreter comes from each file’s **shebang** (often `#!/usr/bin/env bash` or another interpreter on your `PATH`). **Shell lines inside workflows** (after Jaiph interpolation) run via **`sh -c`**, so a POSIX **`sh`** must exist.

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

This downloads the per-platform standalone binary for your host (`jaiph-{darwin|linux}-{arm64|x64}`) plus `SHA256SUMS` from the matching GitHub Release, **verifies the checksum**, and installs the binary to `~/.local/bin/jaiph`. The binary is fully self-contained — no `LIB_DIR` tree, no node shim. Override the install location with `JAIPH_BIN_DIR` and the release ref with the first positional argument or `JAIPH_REPO_REF` (default: the current stable tag; `nightly` resolves to the rolling prerelease). Alternatively:

```bash
npm install -g jaiph
```

`jaiph init` always writes `.jaiph/SKILL.md`. The CLI prefers a disk copy (`JAIPH_SKILL_PATH`, or `docs/jaiph-skill.md` under the current working directory), and falls back to an **embedded copy baked into the binary** so a curl-installed jaiph (no sibling `docs/` on disk) still produces a `SKILL.md`. Override it with **`JAIPH_SKILL_PATH`** when you want a custom skill (for example the repo’s `docs/jaiph-skill.md`, or download the canonical raw skill: `https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md`).

Verify:

```bash
jaiph --version
```

If the command is not found, ensure `~/.local/bin` (installer) or the npm global bin directory is on your **`PATH`** (the **`docs/run`** helper prepends `$HOME/.local/bin` automatically after installing).

Switch versions anytime: **`jaiph use`** runs your install command via **`bash -c`** (default: `curl -fsSL https://jaiph.org/install | bash`) with **`JAIPH_REPO_REF`** set to **`nightly`** or to **`v`** plus the version (for example **`0.9.4`** → **`v0.9.4`**). The installer re-downloads the corresponding release binary and replaces the one at `~/.local/bin/jaiph`.

```bash
jaiph use nightly
jaiph use 0.9.4    # reinstalls the v0.9.4 release binary
```

Default install invocation is `curl -fsSL https://jaiph.org/install | bash`; override **`JAIPH_INSTALL_COMMAND`** when you need a fork, offline bundle, or local script (**`docs/install-from-local.sh`** wraps `docs/install` with a repo path and builds the binary locally with Bun — see [Contributing](contributing.md#installing-from-source)).

## Quick try

Run a sample workflow without installing first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log response
}'
```

The script installs Jaiph if it is missing, then runs the workflow in a fresh temp directory that includes a **`.jaiph`** marker (so Docker sandboxes only mount that tree — see comments in the repo’s [`docs/run`](https://github.com/jaiphlang/jaiph/blob/main/docs/run)). Requires **`node`** and **`curl`**. For local docs or CI without production URLs, set **`JAIPH_SITE`** (documented in the same file).

For more runnable samples (inbox, async, testing, ensure/catch), see the [`examples/`](https://github.com/jaiphlang/jaiph/tree/main/examples) directory.

## Running a workflow

Jaiph workflows live in **`.jh`** files (**`*.test.jh`** suites use **`jaiph test`** instead — see [Testing](testing.md)). **`jaiph run`** loads a **single entry file** and runs the workflow named **`default`** (`workflow default(...) { ... }`). Use a **shebang** (`#!/usr/bin/env jaiph`) or the CLI: if the first argument is an existing file path, names ending in **`.test.jh`** dispatch to **`jaiph test`** (this check runs before the generic **`.jh`** rule), and every other **`.jh`** file dispatches to **`jaiph run`** (see [CLI — file shorthand](cli.md#file-shorthand)).

```bash
./path/to/main.jh "feature request or task"
# or explicitly:
jaiph run ./path/to/main.jh "feature request or task"
```

Arguments after the `.jh` path are bound **by position** to the named parameters of `workflow default` (for example `workflow default(task)` → `${task}` in the body; see [Language — Parameters and arguments](language.md#parameters-and-arguments)).

### Workspace root

The CLI sets **`JAIPH_WORKSPACE`** to a **workspace root** before it spawns the workflow runner. For **`jaiph run`**, detection starts at the **directory containing the entry `.jh` file** and walks **upward** until it finds **`.jaiph`** or **`.git`**, with guards for shared temp trees (see `detectWorkspaceRoot` in `src/cli/shared/paths.ts`). If no marker is found before the filesystem root, the **starting directory** (the entry file’s directory) is used as the workspace. That root is what import resolution and **`.jaiph/libs/`** are scoped to (see [Libraries](libraries.md)).

Managed **script** steps receive **`$1`**, **`$2`**, … only for arguments passed at the corresponding **`run`** step in the workflow — not automatically from the CLI unless the workflow forwards them (see [Language — `run`](language.md#run--execute-a-workflow-or-script)).

### Run artifacts

Each run writes durable files under **`.jaiph/runs/`**. See [Runtime artifacts](artifacts.md) for layout, per-step logs, the JSONL timeline, and inbox files.

### Formatting

Enforce consistent style across `.jh` / `*.test.jh` files (paths must end in **`.jh`**):

```bash
jaiph format flow.jh           # rewrite in place
jaiph format --check flow.jh tests/flow.test.jh   # CI-safe: exits 1 when changes needed
jaiph format --indent 4 flow.jh
```

Use your shell’s globbing if you pass multiple files (for example `jaiph format --check *.jh` when your shell expands the pattern). See [CLI — `jaiph format`](cli.md#jaiph-format).

### Validate, test, and libraries (next steps)

- **`jaiph compile`** — validates the import closure (**`validateReferences` only**); no script emission or runner. See [Architecture — Summary](architecture.md#summary) and [CLI](cli.md).
- **`jaiph test`** — runs **`*.test.jh`** blocks in-process with mocks. See [Testing](testing.md).
- **`jaiph install`** — fetches reusable modules into **`.jaiph/libs/`**; workspace root is detected from your **current working directory** (not the entry-`.jh` rule used by **`jaiph run`**). See [Libraries](libraries.md) and [CLI — `jaiph install`](cli.md#jaiph-install).

## Workspace setup

### Initialize with `jaiph init`

```bash
jaiph init              # current directory (default)
jaiph init path/to/repo # explicit workspace root
```

This creates **`.jaiph/`** under the chosen root with:

- **`.jaiph/.gitignore`** — ignores ephemeral **`runs/`** and **`tmp/`** under **`.jaiph/`** (workflows and libraries stay tracked).
- **`.jaiph/bootstrap.jh`** — executable **`workflow default`** whose template uses a triple-quoted multiline **prompt**; it tells the agent to read **`.jaiph/SKILL.md`**, scaffold workflows under **`.jaiph/`**, and end with **WHAT CHANGED** and **WHY**; the workflow **`log`**s the result.
- **`.jaiph/SKILL.md`** — always written. If **`JAIPH_SKILL_PATH`** is set **and** that path exists, it wins; otherwise the CLI tries **`docs/jaiph-skill.md`** under the current working directory and finally falls back to the copy **embedded in the binary**. Resolution lives in **`loadInstalledSkillContent()`** / **`resolveInstalledSkillPath()`** (`src/cli/shared/paths.ts`). Same rules as [CLI — `jaiph init`](cli.md#jaiph-init).

Run the bootstrap workflow:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files under **`<project_root>/.jaiph/`** so workspace-root detection and agent setup stay predictable. The runtime sees **`JAIPH_WORKSPACE`** as that detected root (same root the validator uses for **`.jaiph/libs/`** imports). Optional Docker sandboxes use a separate mount contract; see [Sandboxing](sandboxing.md) for how **`jaiph run`** selects container vs host execution.

### Building from source

Contributors typically clone the repo, run **`npm install`** and **`npm run build`**, and invoke **`node dist/src/cli.js`**; to produce the same single-file binary the curl installer fetches from a Release, run **`npm run build:standalone`** (requires Bun) — or call **`./docs/install-from-local.sh`** to install that binary directly. See [Contributing — Installing from source](contributing.md#installing-from-source).
