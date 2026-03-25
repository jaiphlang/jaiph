# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](https://jaiph.org/getting-started) ([`docs/getting-started.md`](docs/getting-started.md)) · [CLI](docs/cli.md) · [Reporting](docs/reporting.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md) · [Sandboxing](docs/sandboxing.md) · [Agent skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) · [Contributing](docs/contributing.md)

---

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Features:**

- **Workflows** — Ordered Jaiph steps (`ensure`, `run`, `prompt`, `const`, `if`, `fail`, `return`, `log` / `logerr`, inbox `send` / `route`, async `run … &` + `wait`, and optional legacy shell lines). Orchestration stays declarative; **bash execution belongs in `function` blocks** (and optional shell steps where the grammar still allows them).
- **Rules** — Reusable checks implemented as **structured steps** (`ensure`, `run` to functions, `const`, `if`, `fail`, `log` / `logerr`, `return`) plus shell fragments where accepted. Used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI). Supports validated JSON responses via `returns '{ field: type }'`.
- **Composability** — Import other `.jh` modules and call their rules, workflows, and functions by alias. **Managed calls only:** `ensure` for rules, `run` for workflows and functions — keywords make each call explicit; a Jaiph symbol must not be the first command word of a workflow shell line, **even when that line also uses `$(...)`**. Assignment capture (`x = ensure …`, `x = run …`, or `const x = …`) reads the callee’s explicit `return` value; command stdout is logged to `.jaiph/runs`, not mixed into the variable. Do not wrap Jaiph symbols in `$(...)` or call module functions as bare shell steps in workflows.
- **Shell-native** — Transpiled output is bash. Use **`function`** bodies for command pipelines, tests, and helpers; **`const`** / **`local`** (module-level) for shared values. Generated scripts default **`JAIPH_LIB`** to `<workspace>/.jaiph/lib` (via `JAIPH_WORKSPACE`) so `source "$JAIPH_LIB/…"` resolves predictably. See [Grammar](docs/grammar.md), [CLI environment variables](docs/cli.md#environment-variables), and `.jaiph/language_redesign_spec.md` for the orchestration vs execution boundary.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- **Documentation:** [Getting started (site)](https://jaiph.org/getting-started) · [Getting started (repo)](docs/getting-started.md) — install, first run, language map. Other guides are linked from the site and from the links at the top of this file.
- **Agent skill (for AI assistants authoring `.jh` workflows):** <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>
- **Samples:** <https://github.com/jaiphlang/jaiph/tree/main/samples>
- **Contributing:** <https://github.com/jaiphlang/jaiph/issues>

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

rule build_passes {
  run npm_run_build
}

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

workflow update_docs {
  prompt "Update docs"
}
```

Transpiled output is standard bash and sources the installed global Jaiph runtime stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`), so workflows remain shell-native.

## Getting Started

### Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

Verify: `jaiph --version`. Switch version: `jaiph use nightly` or `jaiph use 0.5.0`.

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).

### Run a workflow

```bash
./path/to/main.jh "feature request or task"
# or: jaiph run ./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`). The file must define a `workflow default`.

When stdout is not a terminal (for example in CI), long-running steps can print periodic gray **heartbeat** lines between the start and completion markers so logs show the run is still active. See [CLI Reference — Run progress and tree output](docs/cli.md#run-progress-and-tree-output).

Each run directory includes **`run_summary.jsonl`**, an append-only JSONL timeline of workflow boundaries, step start/end, `log` / `logerr`, and inbox enqueue/dispatch events — useful for dashboards and offline analysis. See [CLI — Run summary](docs/cli.md#run-summary-jsonl) for event types, required and optional fields, and correlation rules (`event_version` 1). **`jaiph report`** starts a local read-only web UI over `.jaiph/runs` (history, step tree, logs, live tail of active runs); see [Reporting server](docs/reporting.md).

### Initialize a workspace

```bash
jaiph init && ./.jaiph/bootstrap.jh
```

This creates `.jaiph/bootstrap.jh` and `.jaiph/jaiph-skill.md`, then runs the bootstrap workflow which asks an agent to scaffold recommended workflows for your project. Tip: add `.jaiph/` to your `.gitignore`.

For the full language reference, CLI commands, configuration, testing, Docker sandboxing, hooks, and inbox dispatch, see [Getting Started](docs/getting-started.md) or visit [jaiph.org](https://jaiph.org).

## Contributing

See [Contributing](docs/contributing.md) for branch strategy, pull requests, the Node/Jest and bash E2E test layers, and code style expectations. Use [GitHub Issues](https://github.com/jaiphlang/jaiph/issues) for bugs and feature discussion.

## License

[Apache License 2.0](LICENSE).
