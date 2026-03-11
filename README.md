# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](docs/getting-started.md) · [CLI](docs/cli.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

[jaiph.org](https://jaiph.org)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Features:**

- **Workflows** — Ordered steps (checks, agent prompts, shell, calls to other workflows) that can change system state.
- **Rules** — Reusable checks or actions that return a shell exit code; used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI).
- **Composability** — Import other `.jh` modules and call their rules/workflows by alias.
- **Shell-native** — Transpiled output is bash; you can mix Jaiph primitives with normal shell commands.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- **Documentation:** [Getting started](docs/getting-started.md) · <https://jaiph.org/>
- **Agent skill (for AI agents):** <https://jaiph.org/jaiph-skill.md>
- **Samples:** <https://github.com/jaiphlang/jaiph/tree/main/samples>
- **Contributing:** <https://github.com/jaiphlang/jaiph/issues>

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

Transpiled output is standard bash and sources the installed global Jaiph runtime stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`), so workflows remain shell-native.

## Getting Started

The installation below uses Jaiph from the `main` branch:
<https://github.com/jaiphlang/jaiph>

### Installation

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
jaiph use 0.2.0     # installs tag v0.2.0
```

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).
Installation places both the `jaiph` CLI and the global runtime stdlib (`jaiph_stdlib.sh`) in `~/.local/bin/`.

### Running a workflow

```bash
./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: executable `.jh` or `.jph` files (with `#!/usr/bin/env jaiph`) run `workflow default`.  
`jaiph run path/to/file.jh` (or `file.jph`) is also supported and follows the same argument semantics.

### Initialize Jaiph workspace

```bash
jaiph init
```

This creates `.jaiph/bootstrap.jh` and `.jaiph/jaiph-skill.md` (synced from your installed Jaiph copy).

Then run:

```bash
./.jaiph/bootstrap.jh
```

This asks an agent to detect project configuration and bootstrap recommended Jaiph workflows for feature implementation.

Tip: add `.jaiph/runs/` to your `.gitignore`.

### Run reporting and logs

- During `jaiph run`, progress rendering is event-driven.
  - **TTY:** The progress tree is identical to non-TTY: each task line shows icon and final time when the step completes (e.g. `✓ 0s`, `▸ prompt (Donald)` then on completion `✓ 2s`). No per-step live elapsed on tree rows. A single **bottom line** shows `  RUNNING workflow <name> (X.Xs)` (RUNNING yellow, "workflow" bold, workflow name default, time dim) and is the only line updated in place (e.g. every second). When the run completes, that line is removed.
  - **Non-TTY:** One completion line per finished step; no RUNNING line, no in-place updates.
- For parameterized steps (`workflow`, `prompt`, `function`), the tree shows passed argument values inline in gray (comma-separated values in parentheses; no labels; values truncated to 32 chars).
- Each run writes `.jaiph/runs/<timestamp>-<id>/run_summary.jsonl`.
- Step `.out` / `.err` files are created only when the step produced output (empty log files are skipped).

### Configuration

Runtime behavior is controlled by in-file config and environment variables. See [configuration.md](docs/configuration.md) for details.

Typical config block:

```jh
config {
  agent.default_model = "gpt-4"
  agent.command = "cursor-agent"
  agent.backend = "cursor"
  agent.trusted_workspace = ".jaiph/.."
  agent.cursor_flags = "--force"
  agent.claude_flags = "--model sonnet-4"
  run.logs_dir = ".jaiph/runs"
  run.debug = false
}
```

Important:

- You can set `agent.backend` to `"cursor"` (default) or `"claude"` per workflow file; `JAIPH_AGENT_BACKEND` overrides it. When backend is `"claude"`, the Anthropic Claude CLI (`claude`) must be on PATH or the run fails with a clear error.
- `agent.trusted_workspace` sets Cursor backend trust scope (`--trust`), defaulting to project root.
- `agent.command` accepts executable + inline args (for example `cursor-agent --force`).
- `agent.cursor_flags` / `agent.claude_flags` append backend-specific CLI flags (split on whitespace).
- Environment variables override config values (for example `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`).

### CLI reference

See [cli.md](docs/cli.md) for command syntax, examples, and supported environment variables. For custom commands at workflow/step events, see [Hooks](docs/hooks.md).

## Language Primitives

- `import "file.jh" as alias`  
  Imports rules/workflows from another Jaiph module under an alias. Imports are verified at compile time.

- `rule name { ... }`  
  Defines a reusable check/action that returns a shell exit code. Rules run in a read-only subshell and preserve stdout. Rules can consume positional parameters (`$1`, `$2`, `"$@"`) forwarded by `ensure`.

- `workflow name { ... }`  
  Defines an orchestration entrypoint made of ordered steps. Workflows can change system state.

- `function name() { ... }`  
  Defines a reusable writable shell function. Functions can be called from workflows/rules and are tracked as regular Jaiph steps.

- `ensure ref [args...]`  
  Executes a rule in a workflow or another rule, optionally forwarding arguments (for example: `ensure my_rule "$1"`). Optional **recover** turns it into a bounded retry loop: on failure run the recover body (single statement or `recover { stmt; stmt; ... }`), then re-check; repeat until the rule passes or `JAIPH_ENSURE_MAX_RETRIES` (default 10) is exceeded, then exit 1 (e.g. `ensure dep recover run install_deps`).

- `run ref`  
  Executes another workflow from a workflow. `run` is not allowed inside a rule; use `ensure` to call another rule or move the call to a workflow.

- `prompt "..."`  
  Sends prompt text to the configured agent command.

All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Parser limitation: inline brace-group short-circuit patterns like `cmd || { ... }` are not supported in `.jh`/`.jph` files yet. Use explicit conditionals like `if ! cmd; then ...; fi` instead.
- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

## More Documentation

- [Getting started](docs/getting-started.md) — installation, first workflow, workspace setup
- [Agent skill](https://jaiph.org/jaiph-skill.md) — guide for AI agents that generate or modify Jaiph workflows
- Full docs: <https://jaiph.org/>
- [CLI reference](docs/cli.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md)
