# ![Jaiph](logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

This page is the main entry point for the documentation. For reference, see [CLI](cli.md), [Configuration](configuration.md), [Grammar](grammar.md), and [Testing](testing.md); for AI agents that generate workflows, see the [Agent Skill](https://jaiph.org/jaiph-skill.md).

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

[jaiph.org](https://jaiph.org)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

**Goals and concepts:**

- **Workflows** — Ordered steps (checks, agent prompts, shell, calls to other workflows) that can change system state.
- **Rules** — Reusable checks or actions that return a shell exit code; used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI); workflows orchestrate when the agent runs.
- **Composability** — Import other `.jh` modules and call their rules/workflows by alias (e.g. `ensure security.scan_passes`, `run bootstrap.nodejs`).
- **Shell-native** — Transpiled output is bash; you can mix Jaiph primitives with normal shell commands and variables.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs (canonical): <https://jaiph.org/>
- Agent skill: <https://jaiph.org/jaiph-skill.md>
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

Entrypoint resolution: executable `.jh` or `.jph` files with `#!/usr/bin/env jaiph` run `workflow default`. You can also run `jaiph run path/to/file.jh` (or `file.jph`); arguments are passed the same way.

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

- During `jaiph run`, progress is event-driven. **TTY:** The tree is the same as non-TTY (task rows with final time when each step completes); a single bottom line `  RUNNING workflow <name> (X.Xs)` is the only line updated in place (~1 Hz) and is removed when the run finishes. **Non-TTY:** One line per finished step; no RUNNING line.
- Parameterized steps (`workflow`, `prompt`, `function`) show passed argument values inline in the tree (gray, comma-separated values in parentheses; no parameter names; values truncated to 32 characters). See [CLI](cli.md) for details.
- Each run creates a run directory under the logs dir (default `.jaiph/runs/`) named `<timestamp>-<id>`, containing `run_summary.jsonl`.
- Step `.out` and `.err` files are written only when the step produced output (empty files are not created).

### Configuration

Runtime behavior is controlled by in-file config and environment variables. See [configuration.md](configuration.md) for details.

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

- `agent.trusted_workspace` sets the Cursor backend trust scope (`--trust`); it defaults to the project root.
- `agent.command` is the executable (and optional inline args) for the Cursor backend, e.g. `cursor-agent --force`.
- `agent.cursor_flags` and `agent.claude_flags` append backend-specific CLI flags (split on whitespace).
- Environment variables override config: `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, etc. See [configuration.md](configuration.md).

### CLI reference

See [cli.md](cli.md) for command syntax, examples, and supported environment variables.

## Language Primitives

- `config { ... }`  
  Optional block in the entry workflow file (at the top, optionally after shebang or imports). Sets runtime options (e.g. `agent.backend`, `agent.command`, `agent.trusted_workspace`, `run.logs_dir`). The opening line must be exactly `config {` on its own line. Only one config block per file. Environment variables override. See [configuration.md](configuration.md).

- `import "file.jh" as alias`  
  Imports rules/workflows from another Jaiph module under an alias. Imports are verified at compile time.

- `rule name { ... }`  
  Defines a reusable check or action that returns a shell exit code. Rules run in a read-only subshell (best-effort; full isolation on Linux with `unshare`, child shell elsewhere) and preserve stdout. They can take positional parameters (`$1`, `$2`, `"$@"`) forwarded by `ensure`. Optional: `export rule name { ... }` so the rule can be used when the module is imported.

- `workflow name { ... }`  
  Defines an orchestration entrypoint made of ordered steps. Workflows can change system state. Optional: `export workflow name { ... }` so the workflow can be run via the module alias.

- `function name() { ... }`  
  Defines a reusable writable shell function. Functions can be called from workflows/rules and are tracked as regular Jaiph steps.

- `ensure ref [args...]`  
  Executes a rule in a workflow or another rule, optionally forwarding arguments (for example: `ensure my_rule "$1"`). Optional: `ensure ref recover <stmt>` or `ensure ref recover { stmt; stmt; }` for a bounded retry loop (run rule; on failure run recover body; repeat until success or `JAIPH_ENSURE_MAX_RETRIES` exceeded, then exit 1; default max 10).

- `run ref [args...]`  
  Executes another workflow from a workflow. You can pass arguments (e.g. `run update_docs "$1"`). `run` is not allowed inside a rule; use `ensure` to call another rule or call the workflow from a workflow.

- **Conditionals** — `if ! ensure ref; then ... fi` runs the then-branch when the rule fails. The then-branch may contain `run`, `prompt`, and shell commands. For a pure shell condition, `if ! <shell_condition>; then ... fi` is also supported; in that case the then-branch may contain only `run` and shell commands (no `prompt`).

- `prompt "..."`  
  Sends the prompt text to the configured agent command. Variable expansion (`$1`, `${VAR}`) is allowed in the string; command substitution (`$(...)`) and backticks are rejected at parse time.

- `name = prompt "..."`  
  Same as `prompt "..."` but captures the agent’s stdout into the variable `name` for use in later steps.

All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Parser limitation: inline brace-group short-circuit patterns like `cmd || { ... }` are not supported in `.jh`/`.jph` files yet. Use explicit conditionals like `if ! cmd; then ...; fi` instead.
- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

## More Documentation

- Full docs: <https://jaiph.org/>
- Grammar: [grammar.md](grammar.md)
- Testing: [testing.md](testing.md)
- Agent bootstrap skill: <https://jaiph.org/jaiph-skill.md>
- Configuration: [configuration.md](configuration.md)
- CLI: [cli.md](cli.md)
