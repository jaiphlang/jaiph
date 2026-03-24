# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting Started](docs/getting-started.md) · [CLI](docs/cli.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md) · [Sandboxing](docs/sandboxing.md) · [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md)

---

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Features:**

- **Workflows** — Ordered steps (checks, agent prompts, shell, `run` calls to other workflows and functions) that can change system state.
- **Rules** — Reusable checks or actions that return a shell exit code; used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI). Supports validated JSON responses via `returns '{ field: type }'`.
- **Composability** — Import other `.jh` modules and call their rules, workflows, and functions by alias. **Managed calls only:** `ensure` for rules, `run` for workflows and functions — keywords make each call explicit; a Jaiph symbol must not be the first command word of a workflow shell line, **even when that line also uses `$(...)`**. Assignment capture (`x = ensure …`, `x = run …`) reads the callee’s explicit `return` value; command stdout is logged to `.jaiph/runs`, not mixed into the variable. Do not wrap Jaiph symbols in `$(...)` or call module functions as bare shell steps in workflows.
- **Shell-native** — Transpiled output is bash; you can mix Jaiph primitives with normal shell commands.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- **Documentation:** [Getting Started](docs/getting-started.md) — installation, first workflow, language overview. Full reference: <https://jaiph.org/>
- **Agent skill (for AI agents):** <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>
- **Samples:** <https://github.com/jaiphlang/jaiph/tree/main/samples>
- **Contributing:** <https://github.com/jaiphlang/jaiph/issues>

## Example

`main.jh`:

```jaiph
#!/usr/bin/env jaiph

import "bootstrap_project.jh" as bootstrap
import "tools/security.jh" as security

rule project_ready {
  test -f "package.json"
  test -n "$NODE_ENV"
}

rule build_passes {
  npm run build
}

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

Verify: `jaiph --version`. Switch version: `jaiph use nightly` or `jaiph use 0.4.0`.

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).

### Run a workflow

```bash
./path/to/main.jh "feature request or task"
# or: jaiph run ./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`). The file must define a `workflow default`.

When stdout is not a terminal (for example in CI), long-running steps can print periodic gray **heartbeat** lines between the start and completion markers so logs show the run is still active. See [CLI Reference — Run progress and tree output](docs/cli.md#run-progress-and-tree-output).

Each run directory includes **`run_summary.jsonl`**, an append-only JSONL timeline of workflow boundaries, step start/end, `log` / `logerr`, and inbox enqueue/dispatch events — useful for dashboards and offline analysis. See [CLI — Run summary](docs/cli.md#run-summary-jsonl).

### Initialize a workspace

```bash
jaiph init && ./.jaiph/bootstrap.jh
```

This creates `.jaiph/bootstrap.jh` and `.jaiph/jaiph-skill.md`, then runs the bootstrap workflow which asks an agent to scaffold recommended workflows for your project. Tip: add `.jaiph/` to your `.gitignore`.

For the full language reference, CLI commands, configuration, testing, Docker sandboxing, hooks, and inbox dispatch, see [Getting Started](docs/getting-started.md) or visit [jaiph.org](https://jaiph.org).

## Contributing

See [Contributing](docs/contributing.md) for branching strategy, pull request guidance, and E2E testing standards.
