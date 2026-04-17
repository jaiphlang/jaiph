---
title: Setup
permalink: /setup
redirect_from:
  - /setup.md
---

# Setup

Install Jaiph, try it without a full checkout, run workflows, and scaffold a project workspace.

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

Switch versions at any time:

```bash
jaiph use nightly
jaiph use 0.9.2
```

## Quick try

Run a sample workflow without installing first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log response
}'
```

The script installs Jaiph automatically if it is not already on your `PATH`. Requires `node` and `curl`.

For more runnable samples (inbox, async, testing, ensure/catch), see the [`examples/`](https://github.com/jaiphlang/jaiph/tree/main/examples) directory.

## Running a workflow

Jaiph workflows are `.jh` files. Every workflow file needs a `workflow default` as its entry point. Run it directly (with a shebang) or through the CLI:

```bash
./path/to/main.jh "feature request or task"
# or explicitly:
jaiph run ./path/to/main.jh "feature request or task"
```

Arguments are bound to **named parameters** declared on the default workflow (e.g. `workflow default(task)` → `${task}`). In script bodies, standard shell positional parameters apply (`$1`, `$2`, `"$@"`).

### Run artifacts

Each run writes durable files under `.jaiph/runs/`. See [Runtime artifacts](artifacts.md) for the directory layout, per-step logs, the JSONL timeline, and inbox files.

### Formatting

Enforce consistent style across `.jh` files:

```bash
jaiph format flow.jh           # rewrite in place
jaiph format --check *.jh      # CI-safe: exits 1 when changes needed
jaiph format --indent 4 flow.jh
```

See [CLI — `jaiph format`](cli.md#jaiph-format) for all options.

## Workspace setup

### Initialize with `jaiph init`

```bash
jaiph init
```

This creates a `.jaiph/` directory in your project root with:

- `.jaiph/.gitignore` — ignores ephemeral `runs/` and `tmp/` under `.jaiph/` (workflows and libraries stay tracked)
- `.jaiph/bootstrap.jh` — an interactive workflow that asks an agent to scaffold recommended workflows for your project. The generated template uses a triple-quoted multiline prompt (`prompt """ ... """`), explicitly asks the agent to review/update `.jaiph/Dockerfile` for this repository's sandbox needs, and logs a final summary of what changed and why
- `.jaiph/Dockerfile` — generated project sandbox image template (`ubuntu:latest`, common utilities, Node.js LTS, Claude Code CLI, cursor-agent). It installs Jaiph with the default installer path: `curl -fsSL https://jaiph.org/install | bash`
- `.jaiph/SKILL.md` — the agent skill file for AI assistants authoring `.jh` workflows (from your Jaiph installation, or `JAIPH_SKILL_PATH`)

Run the bootstrap workflow to get started:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files in `<project_root>/.jaiph/` so workspace-root detection and agent setup stay predictable. Jaiph resolves `JAIPH_WORKSPACE` to the project root. Reusable `.jh` modules installed with `jaiph install` live under `.jaiph/libs/` (see [Libraries](libraries.md)).
