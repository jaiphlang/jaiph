---
title: Setup
permalink: /setup
redirect_from:
  - /setup.md
---

# Setup

This page is about **getting the Jaiph CLI on your machine** and **turning a directory into a Jaiph-friendly workspace**: install paths, a one-liner “try it” flow, how `jaiph run` wires arguments into workflows, formatting and artifacts, and what `jaiph init` drops into `.jaiph/`.

For how the CLI, transpiler, and Node runtime fit together (including `JAIPH_WORKSPACE` and the detached runner), see [Architecture](architecture.md).

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

This installs Jaiph to `~/.local/bin`. Alternatively, install from npm:

```bash
npm install -g jaiph
```

Verify with:

```bash
jaiph --version
```

If the command is not found, ensure `~/.local/bin` (installer) or the npm global bin directory is in your `PATH`.

Switch versions at any time (re-runs the install script with a Git ref: `nightly` or `v<version>` such as `v0.9.3` when you pass `0.9.3`):

```bash
jaiph use nightly
jaiph use 0.9.3
```

The default install command is `curl -fsSL https://jaiph.org/install | bash`. Override it with `JAIPH_INSTALL_COMMAND` if you need a fork, air-gapped bundle, or local script.

## Quick try

Run a sample workflow without installing first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log response
}'
```

The script installs Jaiph automatically if it is not already on your `PATH`. Requires `node` and `curl`. For local docs or CI without hitting production URLs, the same script honors `JAIPH_SITE` (see header comments in the repo’s [`docs/run`](https://github.com/jaiphlang/jaiph/blob/main/docs/run) file).

For more runnable samples (inbox, async, testing, ensure/catch), see the [`examples/`](https://github.com/jaiphlang/jaiph/tree/main/examples) directory.

## Running a workflow

Jaiph workflows are `.jh` files. `jaiph run` loads a single file as the entry module and requires a workflow named **`default`** (`workflow default(...) { ... }`). Run it directly (executable file with a `#!/usr/bin/env jaiph` shebang) or through the CLI:

```bash
./path/to/main.jh "feature request or task"
# or explicitly:
jaiph run ./path/to/main.jh "feature request or task"
```

Arguments after the `.jh` path are bound **by position** to the named parameters of `workflow default` (for example `workflow default(task)` → `${task}` in the body; see [Language — Parameters and arguments](language.md#parameters-and-arguments)). The CLI sets `JAIPH_WORKSPACE` to the detected workspace root (walk upward from the directory containing the entry `.jh` file, looking for `.jaiph` / `.git` markers; see [Architecture](architecture.md)); managed **script** steps receive `$1`, `$2`, … only for arguments passed at the corresponding `run` step, not automatically from the CLI unless the workflow forwards them (see [Language — `run`](language.md#run--execute-a-workflow-or-script)).

### Run artifacts

Each run writes durable files under `.jaiph/runs/`. See [Runtime artifacts](artifacts.md) for the directory layout, per-step logs, the JSONL timeline, and inbox files.

### Formatting

Enforce consistent style across `.jh` files:

```bash
jaiph format flow.jh           # rewrite in place
jaiph format --check *.jh      # CI-safe: exits 1 when changes needed; *.test.jh matches too (suffix .jh)
jaiph format --indent 4 flow.jh
```

See [CLI — `jaiph format`](cli.md#jaiph-format) for all options.

## Workspace setup

### Initialize with `jaiph init`

```bash
jaiph init              # current directory (default)
jaiph init path/to/repo # explicit workspace root
```

This creates a `.jaiph/` directory under the chosen root with:

- `.jaiph/.gitignore` — ignores ephemeral `runs/` and `tmp/` under `.jaiph/` (workflows and libraries stay tracked)
- `.jaiph/bootstrap.jh` — an interactive workflow that asks an agent to scaffold recommended workflows for your project. The generated template uses a triple-quoted multiline prompt (`prompt """ ... """`) and logs the bootstrap summary (`log` of the prompt result).
- `.jaiph/SKILL.md` — copied from the skill file resolved at init time: if `JAIPH_SKILL_PATH` points at an existing file, that wins; otherwise the CLI searches paths next to the installed package and typical checkout layouts (including `./docs/jaiph-skill.md` when your cwd is the repo root). If none is found, init skips the file and tells you to set `JAIPH_SKILL_PATH` and run again.

Run the bootstrap workflow to get started:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files in `<project_root>/.jaiph/` so workspace-root detection and agent setup stay predictable. The CLI exports `JAIPH_WORKSPACE` to that detected root when it launches the workflow runner (same root the validator uses for `.jaiph/libs/` imports). Reusable `.jh` modules installed with `jaiph install` live under `.jaiph/libs/` (see [Libraries](libraries.md)). Optional Docker sandboxes use a separate mount contract; see [Sandboxing](sandboxing.md) for how `jaiph run` selects container vs host execution.
