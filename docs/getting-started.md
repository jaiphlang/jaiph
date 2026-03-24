---
title: Getting Started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

This page walks you through installing Jaiph, running your first workflow, and understanding the core language.

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Core concepts:**

- **Workflows** — Ordered steps (checks, agent prompts, shell, `run` calls to other workflows and functions) that can change system state.
- **Rules** — Reusable checks or actions that return a shell exit code; used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI); workflows orchestrate when the agent runs.
- **Composability** — Import other `.jh` modules and call their rules, workflows, and functions by alias (e.g. `ensure security.scan_passes`, `run bootstrap.nodejs`). Use **`ensure` only for rules** and **`run` for workflows and functions** so every Jaiph call is keyword-led; a symbol name alone cannot start a shell step, including on lines that also contain `$(...)`. Capture return data with `x = ensure …` / `x = run …` (value = explicit `return` in the callee, logs in `.jaiph/runs`). See [Grammar — Step Output Contract](grammar.md#step-output-contract) and [Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).
- **Shell-native** — Transpiled output is bash; you can mix Jaiph primitives with normal shell commands and variables.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs (canonical): <https://jaiph.org/>
- Agent skill: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>
- Samples: <https://github.com/jaiphlang/jaiph/tree/main/samples>
- Contribute: <https://github.com/jaiphlang/jaiph/issues>

## Example

`main.jh`:

```jaiph
#!/usr/bin/env jaiph

import "bootstrap_project.jh" as bootstrap
import "tools/security.jh" as security

# Validates local build prerequisites.
rule project_ready {
  test -f "package.json"
  test -n "$NODE_ENV"
}

# Verifies the project compiles successfully.
rule build_passes {
  npm run build
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
workflow default {
  if ! ensure project_ready; then
    run bootstrap.nodejs
  fi

  prompt "
    Build the application using best practices.
    Follow requirements: $1
  "

  ensure build_passes
  ensure security.scan_passes

  run update_docs
}

# Refreshes documentation after a successful build.
workflow update_docs {
  prompt "Update docs"
}
```

Transpiled output is standard bash and sources the installed global Jaiph runtime stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`), so workflows remain shell-native. A runnable copy of this example lives in `test/fixtures/` (with stub modules `bootstrap_project.jh` and `tools/security.jh`).

## Installation

```bash
curl -fsSL https://jaiph.org/install | bash
```

Verify installation:

```bash
jaiph --version
```

Switch installed version:

```bash
jaiph use nightly   # tracks main branch
jaiph use 0.4.0     # installs tag v0.4.0
```

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).
Installation places both the `jaiph` CLI and the global runtime stdlib (`jaiph_stdlib.sh`) in `~/.local/bin/`.

## Running a workflow

```bash
./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: executable `.jh` files with `#!/usr/bin/env jaiph` run the `workflow default` defined in that file. You can also use `jaiph run path/to/file.jh`; arguments are passed the same way. The file must define a workflow named `default`. The `.jph` extension is still supported but deprecated for new files.

Other useful CLI commands:

```bash
jaiph build [--target <dir>] [path]   # compile .jh files to bash without running
jaiph test [<dir>|<file.test.jh>]     # run test files (see Testing docs)
jaiph report --workspace .            # browse .jaiph/runs in a local dashboard
```

For all CLI commands, flags, and environment variables, see [CLI Reference](cli.md). For the run history UI and HTTP API, see [Reporting server](reporting.md).

## Initializing a workspace

```bash
jaiph init
```

This creates `.jaiph/bootstrap.jh` and `.jaiph/jaiph-skill.md` (synced from your installed Jaiph copy).

Then run:

```bash
./.jaiph/bootstrap.jh
```

This asks an agent to detect project configuration and bootstrap recommended Jaiph workflows for feature implementation.

Tip: add `.jaiph/` to your `.gitignore`.

## Language overview

Jaiph files (`.jh`) contain **rules**, **workflows**, **functions**, and optional **config** blocks. All primitives interoperate with standard bash. For the full grammar, validation rules, and transpilation details, see [Grammar](grammar.md).

- `config { ... }` — Optional block setting runtime options (agent backend, model, Docker sandbox, etc.). Allowed at the top level (module-wide) and inside individual workflows for per-workflow overrides (`agent.*` and `run.*` keys only). See [Configuration](configuration.md).
- `import "file.jh" as alias` — Import rules, workflows, and functions from another module. Verified at compile time.
- `local name = value` — Module-scoped variable, accessible as `$name` in all blocks within the module.
- `rule name { ... }` — Reusable check/action returning a shell exit code. Runs in an isolated child shell (read-only mount namespace on Linux; child-shell isolation elsewhere). Can call other rules via `ensure`. Optional `export` for cross-module access.
- `workflow name { ... }` — Orchestration entrypoint of ordered steps. Can change system state. Optional `export` for cross-module access.
- `function name { ... }` — Reusable writable shell function (shell-like body; no `run`/`ensure`/routes inside). From a **workflow**, call it with **`run name`** so logs and return values use the managed step contract. The `()` after the name is optional (`function name() { ... }` also works).
- `ensure ref [args...]` — Execute a rule; optional `recover` for bounded retry loops (max retries default to 10).
- `run ref [args...]` — Execute another workflow **or** a top-level function. Not allowed inside rules.
- `prompt "..."` — Send text to the configured agent. Optional `returns '{ field: type }'` for validated JSON responses. See [Grammar](grammar.md).
- `name = <step>` — Capture a value from a step: for `ensure` / `run`, only the callee’s explicit `return` (stdout from commands inside the callee goes to artifacts, not into `name`); for `prompt`, the final answer; for a plain shell command, full stdout (bash semantics). See [Grammar](grammar.md#step-output-contract) and [managed calls](grammar.md#managed-calls-vs-command-substitution).
- `log "message"` / `logerr "message"` — Display a message in the progress tree (stdout / stderr).
- `channel <- cmd` / `channel -> workflow` — Send and route messages between workflows. See [Inbox & Dispatch](inbox.md).
- `cmd &` / `wait` — Background commands and synchronise with `wait` inside shell steps for in-step parallelism. See [Grammar](grammar.md).
- `if [!] ensure ref; then ... [else ...] fi` — Conditional based on rule result.
- `if [!] run ref; then ... [else ...] fi` — Conditional based on workflow or function exit code.
- `if ! <shell_cmd>; then ... fi` — Conditional based on a shell command exit code.

Runtime behavior (progress tree, step output, run logs) is documented in [CLI Reference](cli.md). To browse past and in-progress runs in a browser, use [Reporting server](reporting.md). For agent backend configuration, see [Configuration](configuration.md). For Docker sandboxing (beta), see [Sandboxing](sandboxing.md). For testing workflows with mocks and assertions, see [Testing](testing.md). For lifecycle hooks, see [Hooks](hooks.md).
