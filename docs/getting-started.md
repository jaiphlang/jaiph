---
title: Getting started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

Jaiph is a composable scripting language and runtime for AI agent workflows. You write `.jh` files that combine prompts, rules, scripts, and workflows into executable pipelines. The CLI parses source into an AST, validates references at compile time, and the Node workflow runtime interprets the AST directly. This page covers installation, running your first workflow, workspace setup, and a map of the language.

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

This installs Jaiph to `~/.local/bin`. Verify with:

```bash
jaiph --version
```

If the command is not found, ensure `~/.local/bin` is in your `PATH`.

Switch versions at any time:

```bash
jaiph use nightly
jaiph use 0.6.0
```

## Quick try

Run a sample workflow without installing first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log "${response}"
}'
```

The script installs Jaiph automatically if it is not already on your `PATH`. Requires `node` and `curl`.

For more runnable samples (inbox, async, testing, ensure/recover), see the [`examples/`](https://github.com/jaiphlang/jaiph/tree/main/examples) directory.

## Running a workflow

Jaiph workflows are `.jh` files. Every workflow file needs a `workflow default` as its entry point. Run it directly (with a shebang) or through the CLI:

```bash
./path/to/main.jh "feature request or task"
# or explicitly:
jaiph run ./path/to/main.jh "feature request or task"
```

Arguments are passed positionally. In Jaiph strings (log, prompt, fail, send), reference them as `${arg1}`, `${arg2}`, etc. In script bodies, standard shell positional parameters apply (`$1`, `$2`, `"$@"`).

### Run artifacts

Each run writes artifacts under `.jaiph/runs/<date>/<time>-<source>/`:

- `*.out` / `*.err` — stdout and stderr capture per step
- `run_summary.jsonl` — append-only JSONL event timeline (workflow boundaries, step start/end, log, inbox events)
- `inbox/` — inbox message files (when channels are used)

Add `.jaiph/runs/` to your `.gitignore`.

### Reporting

View run history, step trees, and logs in a local web UI:

```bash
jaiph report --workspace .
```

See [Reporting](reporting.md) for details.

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

- `.jaiph/bootstrap.jh` — an interactive workflow that asks an agent to scaffold recommended workflows for your project
- `.jaiph/jaiph-skill.md` — the agent skill file for AI assistants authoring `.jh` workflows

Run the bootstrap workflow to get started:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files in `<project_root>/.jaiph/` so workspace-root detection and agent setup stay predictable. Jaiph resolves `JAIPH_WORKSPACE` to the project root and `JAIPH_LIB` to `<workspace>/.jaiph/lib` for shared script libraries.

## Language overview

Jaiph source files combine a small orchestration language with scripts in any language. The four core building blocks:

**workflow** — Ordered steps that orchestrate rules, scripts, prompts, and other workflows. Must use Jaiph keywords only (no raw shell lines). Every file needs a `workflow default` entry point.

**rule** — Reusable checks composed of structured steps (`ensure`, `run`, `const`, `if`, `fail`, `return`, `log`). Called with `ensure` from workflows.

**script** — Shell (or polyglot) code blocks that execute as isolated subprocesses. Called with `run` from workflows and rules. Use `script:<tag>` for common interpreters (`script:node`, `script:python3`, `script:ruby`, …) — the tag expands to the correct shebang automatically. For unlisted interpreters, add a manual `#!` shebang as the first body line. Scripts receive only positional arguments and essential Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`). For trivial one-off commands, use **inline scripts**: `run script("echo ok")` — no named `script` block needed.

**prompt** — Sends text to a configured AI agent. Supports structured JSON responses via `returns "{ field: type }"`.

### Key patterns

- `ensure rule()` — run a rule as a check
- `run workflow()` / `run script()` — call a workflow or script
- `run greet(name)` — bare identifier arg, equivalent to `run greet("${name}")`
- `run script("echo ok")` — inline script for trivial one-off commands
- `run async workflow()` — concurrent execution with implicit join
- `const x = prompt "..." returns "{ field: type }"` — structured capture with `${x.field}` access
- `return run workflow()` / `return ensure rule()` — direct return from a managed call
- `ensure rule() recover { ... }` — bounded self-healing retries
- `channel name` / `ch <- "msg"` / `ch -> workflow` — inter-workflow messaging
- `import "file.jh" as alias` — module composition

### Example

```jaiph
#!/usr/bin/env jaiph

script check_deps {
  test -f "package.json"
}

rule deps_exist {
  if not run check_deps() {
    fail "Missing package.json"
  }
}

workflow default {
  ensure deps_exist()
  prompt "Implement the feature: ${arg1}"
}
```

```bash
./main.jh "add user authentication"
```

## Further reading

- [Grammar](grammar.md) — full language reference
- [CLI Reference](cli.md) — commands, flags, environment variables
- [Configuration](configuration.md) — `config` blocks, agent backends, runtime options
- [Testing](testing.md) — `*.test.jh` suites, mocks, assertions
- [Hooks](hooks.md) — lifecycle event automation
- [Inbox & Dispatch](inbox.md) — channel messaging between workflows
- [Sandboxing](sandboxing.md) — Docker isolation
- [Reporting](reporting.md) — run history web UI
- [Architecture](architecture.md) — system structure, execution flow, contracts
- [Contributing](contributing.md) — development setup, testing philosophy
