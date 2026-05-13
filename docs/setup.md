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

- **Node.js** — required to run `jaiph` (the curl installer runs `npm install` and `npm run build` in a checkout).
- **Shell tooling** — the CLI and workflow runtime are Node-based; **emitted `script` steps** run by spawning the script path so the interpreter comes from each file’s **shebang** (often `#!/usr/bin/env bash` or another interpreter on your `PATH`). **Shell lines inside workflows** (after Jaiph interpolation) run via **`sh -c`**, so a POSIX **`sh`** must exist. See [Architecture — Distribution](architecture.md#distribution-node-vs-bun-standalone).

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

This installs a small wrapper **`jaiph`** under `~/.local/bin` plus a **`~/.local/bin/.jaiph/`** tree: `src/` (compiled CLI), `package.json`, and **`jaiph-skill.md`** (copied from the repo for `jaiph init`). Alternatively:

```bash
npm install -g jaiph
```

The published npm package may **not** include `docs/jaiph-skill.md` next to the CLI the way the curl layout does — if **`jaiph init`** does not write `.jaiph/SKILL.md`, point **`JAIPH_SKILL_PATH`** at a skill file (for example the repo’s `docs/jaiph-skill.md`, or download the canonical raw skill: `https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md`).

Verify:

```bash
jaiph --version
```

If the command is not found, ensure `~/.local/bin` (installer) or the npm global bin directory is on your **`PATH`** (the **`docs/run`** helper prepends `$HOME/.local/bin` automatically after installing).

Switch versions anytime: **`jaiph use`** runs your install command via **`bash -c`** (default: `curl -fsSL https://jaiph.org/install | bash`) with **`JAIPH_REPO_REF`** set to **`nightly`** or to **`v`** plus the version (for example **`0.9.4`** → **`v0.9.4`**).

```bash
jaiph use nightly
jaiph use 0.9.4    # reinstalls tag v0.9.4
```

Default install invocation is `curl -fsSL https://jaiph.org/install | bash`; override **`JAIPH_INSTALL_COMMAND`** when you need a fork, offline bundle, or local script (**`docs/install-from-local.sh`** wraps `docs/install` with a repo path).

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
- **`.jaiph/SKILL.md`** — copied when **`jaiph init`** can resolve a skill markdown file: if **`JAIPH_SKILL_PATH`** is set **and** that path exists, it wins; otherwise the CLI tries install-relative paths (`jaiph-skill.md` beside the packaged tree — curl install: **`~/.local/bin/.jaiph/jaiph-skill.md`** next to **`src/`** — then **`docs/jaiph-skill.md`** beside the package when present), then **`docs/jaiph-skill.md`** under the current working directory. Resolution lives in **`resolveInstalledSkillPath()`** (`src/cli/shared/paths.ts`). If nothing resolves, the skill file is skipped and a message tells you to set **`JAIPH_SKILL_PATH`** and run **`jaiph init`** again. Same rules as [CLI — `jaiph init`](cli.md#jaiph-init).

Run the bootstrap workflow:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files under **`<project_root>/.jaiph/`** so workspace-root detection and agent setup stay predictable. The runtime sees **`JAIPH_WORKSPACE`** as that detected root (same root the validator uses for **`.jaiph/libs/`** imports). Optional Docker sandboxes use a separate mount contract; see [Sandboxing](sandboxing.md) for how **`jaiph run`** selects container vs host execution.

### Building from source

Contributors typically clone the repo, run **`npm install`** and **`npm run build`**, and invoke **`node dist/src/cli.js`** (or build the standalone Bun binary per [Contributing](contributing.md)). That path is separate from the curl/npm end-user install above.
