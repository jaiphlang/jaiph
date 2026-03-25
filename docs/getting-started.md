---
title: Getting Started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

This page walks you through installing Jaiph, running your first workflow, and mapping the core language to deeper reference pages.

You will: install the CLI and stdlib, run a workflow (from the shell or as an executable `.jh` file), optionally scaffold `.jaiph/` in a repository, then use the language overview below as an index into [Grammar](grammar.md), [CLI Reference](cli.md), and the other guides.

If you are hacking on the **compiler or CLI** in this repository, read [Contributing](contributing.md) for build commands, tests, and review expectations.

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Core concepts:**

- **Workflows** — Ordered Jaiph steps (`ensure`, `run`, `prompt`, `const`, `if`, `fail`, `return`, logging, inbox, async `run … &` + `wait`, and optional shell). Prefer moving bash into **`function`** blocks and calling them with `run`.
- **Rules** — Structured checks (`ensure`, `run` to functions, `const`, `if`, `fail`, `log` / `logerr`, `return`, plus shell where still accepted); used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI); workflows orchestrate when the agent runs.
- **Composability** — Import other `.jh` / `.jph` modules and call their rules, workflows, and functions by alias (e.g. `ensure security.scan_passes`, `run bootstrap.nodejs`). Use **`ensure` only for rules** and **`run` for workflows and functions** so every Jaiph call is keyword-led; a bare symbol name cannot start a workflow shell step, including when the line also contains `$(...)`.
- **Step capture** — Assign results with `x = ensure …` / `x = run …` / `x = prompt …`, or **`const x = …`** with the same RHS forms (see [Grammar](grammar.md)). For `ensure` / `run`, the captured value is the callee’s explicit `return`; ordinary command stdout goes to step artifacts under `.jaiph/runs`.
- **Shell-native** — Transpiled output is bash. Shared bash helpers can live in `.jaiph/lib/` and be loaded from functions with `source "$JAIPH_LIB/…"`. Emitted scripts export a default `JAIPH_LIB` under the workspace (`JAIPH_WORKSPACE`, or `.` if unset); see [CLI — Environment variables](cli.md#environment-variables).

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs (canonical): <https://jaiph.org/> — tutorial: <https://jaiph.org/getting-started>
- Agent skill: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>
- Samples: <https://github.com/jaiphlang/jaiph/tree/main/samples>
- Contribute: <https://github.com/jaiphlang/jaiph/issues>

## Example

`main.jh`:

```jaiph
#!/usr/bin/env jaiph

import "bootstrap_project.jh" as bootstrap
import "tools/security.jh" as security

function file_exists() {
  test -f "$1"
}

function non_empty() {
  test -n "$1"
}

# Validates local build prerequisites.
rule project_ready {
  if not run file_exists "package.json" {
    fail "expected package.json"
  }
  if not run non_empty "$NODE_ENV" {
    fail "NODE_ENV must be set"
  }
}

function npm_run_build() {
  npm run build
}

# Verifies the project compiles successfully.
rule build_passes {
  run npm_run_build
}

# Orchestrates checks, prompt execution, and docs refresh.
# Arguments:
#   $1: Feature requirements passed to the prompt.
workflow default {
  if not ensure project_ready {
    run bootstrap.nodejs
  }

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

Transpiled output is standard bash. The generated script sources the runtime stdlib by reading **`JAIPH_STDLIB`** if set, otherwise defaulting to **`~/.local/bin/jaiph_stdlib.sh`** (the path used by the install script). When you run a workflow via **`jaiph run`**, **`jaiph ./file.jh`**, or a `#!/usr/bin/env jaiph` shebang, the CLI sets **`JAIPH_STDLIB`** to the `jaiph_stdlib.sh` bundled next to that `jaiph` binary so you always match the compiler version. Advanced overrides are documented under [Environment variables](cli.md#environment-variables).

A runnable copy of this example lives in the Jaiph repository under `test/fixtures/` (with stub modules `bootstrap_project.jh` and `tools/security.jh`).

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
jaiph use 0.5.0     # installs tag v0.5.0
```

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).
Installation places both the `jaiph` CLI and the global runtime stdlib (`jaiph_stdlib.sh`) in `~/.local/bin/`.

## Running a workflow

```bash
./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: the entry file must define a workflow named **`default`**. Executable `.jh` files with `#!/usr/bin/env jaiph` run that workflow when invoked as `./file.jh` (the `jaiph` binary must be on your **`PATH`**). The same applies to **`jaiph run path/to/file.jh`** and the shorthand **`jaiph path/to/file.jh`** when the path exists. The `.jph` extension is still supported but deprecated for new files; **`jaiph run`** prints a deprecation notice on a TTY when you pass a `.jph` path.

Other useful CLI commands:

```bash
jaiph build [--target <dir>] [path]   # compile .jh/.jph files to bash without running
jaiph test [path]                     # run tests (see below)
jaiph report --workspace .            # browse .jaiph/runs in a local dashboard
```

**`jaiph test`:** With no path, Jaiph discovers every `*.test.jh` / `*.test.jph` under the workspace root: walk **up** from the current working directory until a directory containing `.jaiph` or `.git` is found; if neither exists on that path, the root is the resolved cwd. Pass a directory to run all tests under it (workspace root is detected the same way, starting from that path). Pass a single `*.test.jh` / `*.test.jph` file to run one suite. See [Testing](testing.md).

For all CLI commands, flags, and environment variables, see [CLI Reference](cli.md). For the run history UI and HTTP API, see [Reporting server](reporting.md).

## Initializing a workspace

```bash
jaiph init
```

This creates `.jaiph/bootstrap.jh` (executable) and writes `.jaiph/jaiph-skill.md` when the installer ships a skill file next to the `jaiph` binary; if that file is missing, sync is skipped and a note is printed.

Then run:

```bash
./.jaiph/bootstrap.jh
```

This asks an agent to detect project configuration and bootstrap recommended Jaiph workflows for feature implementation.

Tip: add `.jaiph/` to your `.gitignore`.

## Language overview

Jaiph source files use **`.jh`** (recommended); **`.jph`** is still accepted. A file contains **rules**, **workflows**, **functions**, and optional **config** blocks. All primitives interoperate with standard bash. For the full grammar, validation rules, and transpilation details, see [Grammar](grammar.md).

- `config { ... }` — Optional block setting runtime options (agent backend, model, Docker sandbox, etc.). Allowed at the top level (module-wide) and inside individual workflows for per-workflow overrides (`agent.*` and `run.*` keys only). See [Configuration](configuration.md).
- `import "path" as alias` — Import rules, workflows, and functions from another module. The path may include a `.jh` / `.jph` suffix or omit it; resolution prefers `.jh` when both exist. Verified at compile time.
- `local name = value` / `const name = value` — Module-scoped variable, accessible as `$name` in all blocks within the module. Prefer **`const`** in new orchestration code.
- `rule name { ... }` — Reusable check/action: structured Jaiph steps and/or shell. Rules run in an isolated child shell; on Linux, a read-only mount namespace is used when `unshare` and passwordless `sudo` are available, otherwise the same child-shell fallback as on other platforms. Call other rules with **`ensure`**, functions with **`run`**. Optional `export` for cross-module access.
- `workflow name { ... }` — Orchestration entrypoint of ordered steps. Can change system state. Optional `export` for cross-module access.
- `function name { ... }` — Reusable writable shell function (shell-like body; no `run`/`ensure`/routes inside). From a **workflow**, call it with **`run name`** so logs and return values use the managed step contract. The `()` after the name is optional (`function name() { ... }` also works).
- `ensure ref [args...]` — Execute a rule; optional `recover` for bounded retry loops (default max retries **10**, overridable with **`JAIPH_ENSURE_MAX_RETRIES`**). See [Grammar](grammar.md).
- `run ref [args...]` — Execute another workflow **or** a top-level function. Not allowed inside rules.
- `prompt "..."` — Send text to the configured agent. Optional `returns '{ field: type }'` for validated JSON responses. See [Grammar](grammar.md).
- `name = <step>` / `const name = <step>` — Capture or bind: for `ensure` / `run`, only the callee’s explicit `return`; for `prompt`, the final answer; for shell RHS on `const`, only simple values (no `$(...)` — use `run` to a function instead). See [Grammar](grammar.md#step-output-contract).
- `fail "reason"` — Abort the workflow or fail the rule with a message on stderr (non-zero exit).
- `log "message"` / `logerr "message"` — Display a message in the progress tree (stdout / stderr).
- `channel <- cmd` / `channel -> workflow` — Send and route messages between workflows. See [Inbox & Dispatch](inbox.md).
- `run ref &` / `wait` — Background managed runs and join with a **`wait`** step (Jaiph keyword). Shell steps still support `&` / `wait` for raw commands. See [Grammar](grammar.md).
- `if [not] ensure ref { ... }` / `if [not] run ref { ... }` — Brace conditionals (`else if`, `else` supported). Legacy `if … then … fi` / `elif` remains available. Shell-only conditions stay on the legacy `if ! cmd; then … fi` form.

Runtime behavior (progress tree, step output, run logs) is documented in [CLI Reference](cli.md). To browse past and in-progress runs in a browser, use [Reporting server](reporting.md). For agent backend configuration, see [Configuration](configuration.md). For Docker sandboxing (beta), see [Sandboxing](sandboxing.md). For testing workflows with mocks and assertions, see [Testing](testing.md). For lifecycle hooks, see [Hooks](hooks.md).
