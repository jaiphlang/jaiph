---
title: Getting Started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

This page introduces Jaiph, installation, running workflows, and the main language primitives.

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
jaiph use 0.3.0     # installs tag v0.3.0
```

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).
Installation places both the `jaiph` CLI and the global runtime stdlib (`jaiph_stdlib.sh`) in `~/.local/bin/`.

### Running a workflow

```bash
./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: executable `.jh` or `.jph` files with `#!/usr/bin/env jaiph` run the `workflow default` defined in that file. You can also run `jaiph run path/to/file.jh` (or `file.jph`); arguments are passed the same way. The file must define a workflow named `default`.

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
- Parameterized steps (`workflow`, `prompt`, `function`) show passed argument values inline in the tree (gray, comma-separated values in parentheses; no parameter names; workflow/function values truncated to 32 characters). **Prompt** steps show a truncated preview of the prompt text (first 24 characters) and the argument list is capped at 96 characters. See [CLI](cli.md) for details.
- Each run creates a run directory under the logs dir (default `.jaiph/runs/`) using a date/time layout: `<YYYY-MM-DD>/<HH-MM-SS>-<source-file>/`, containing `run_summary.jsonl`. If the same file is run twice in the same second, a collision suffix is appended (`-2`, `-3`, etc.).
- Step `.out` and `.err` files are named with a zero-padded sequence prefix matching step execution order (e.g. `000001-my_workflow__step_name.out`). The counter is shared across subshells, so steps inside looped `run` calls each receive a distinct sequence number. Files are written only when the step produced output (empty files are not created).
- **Prompt steps** show no output in the tree — only the step line and ✓. Use `log` to display agent output in the tree (e.g. `response = prompt "..."; log "$response"`). Prompt `.out` files still contain the full agent transcript for debugging.

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
- Environment variables override config: `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`. See [configuration.md](configuration.md).

### CLI reference

See [cli.md](cli.md) for command syntax, examples, environment variables, and lifecycle hooks.

## Language Primitives

- `config { ... }`
  Optional block in the entry workflow file (at the top, optionally after shebang or imports). Sets runtime options (e.g. `agent.backend`, `agent.command`, `agent.trusted_workspace`, `run.logs_dir`, `runtime.*`). Values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings. The opening line must be exactly `config {` on its own line. Only one config block per file. Environment variables override. See [configuration.md](configuration.md).

- `import "file.jh" as alias`  
  Imports rules/workflows from another Jaiph module under an alias. Imports are verified at compile time.

- `rule name { ... }`  
  Defines a reusable check or action that returns a shell exit code. Rules run in a read-only subshell (best-effort; full isolation on Linux with `unshare`, child shell elsewhere) and preserve stdout. They can take positional parameters (`$1`, `$2`, `"$@"`) forwarded by `ensure`. Optional: `export rule name { ... }` so the rule can be used when the module is imported.

- `workflow name { ... }`  
  Defines an orchestration entrypoint made of ordered steps. Workflows can change system state. Optional: `export workflow name { ... }` so the workflow can be run via the module alias.

- `function name() { ... }`
  Defines a reusable writable shell function. Functions can be called from workflows/rules and are tracked as regular Jaiph steps.

- `local name = value`
  Declares a module-scoped variable at the top level. Values may be double-quoted strings (multi-line, same quoting rules as `prompt`), single-quoted strings, or bare values. The variable is accessible as `$name` inside all rules, functions, and workflows in the same module. Under the hood, Jaiph prefixes the variable to avoid collisions (e.g. `local role` in module `entry` becomes bash variable `entry__role`) and emits `local` shims inside each body. Variable names share the unified namespace with rules, workflows, and functions — duplicates are a parse error. Variables are module-scoped only and not exportable.

- `ensure ref [args...]`  
  Executes a rule in a workflow or another rule, optionally forwarding arguments (for example: `ensure my_rule "$1"`). Optional: `ensure ref recover <stmt>` or `ensure ref recover { stmt; stmt; }` for a bounded retry loop (run rule; on failure run recover body; repeat until success or `JAIPH_ENSURE_MAX_RETRIES` exceeded, then exit 1; default max 10).

- `run ref [args...]`  
  Executes another workflow from a workflow (not a shell command). You can pass arguments (e.g. `run update_docs "$1"`). `run` is not allowed inside a rule; use `ensure` to call another rule or call the workflow from a workflow.

- `log "message"`
  Displays a message in the progress tree at the current depth. Takes a double-quoted string; shell variable interpolation (`$var`, `${var}`) works at runtime. `log` is not a step — no spinner, no timing, no status tracking. Useful for annotating workflow progress (e.g. `log "Starting analysis phase"`).

- **Conditionals** — `if ! ensure ref; then ... fi` runs the then-branch when the rule fails. The then-branch may contain `run`, `prompt`, and shell commands. For a pure shell condition, `if ! <shell_condition>; then ... fi` is also supported; in that case the then-branch may contain only `run` and shell commands (no `prompt`).

- **Agent prompts** — `prompt "..."` sends text to the configured agent command. Variable expansion (`$1`, `${VAR}`) is allowed in the string; command substitution (`$(...)`) and backticks are rejected at parse time. Optional **typed prompt:** `name = prompt "..." returns '{ field: type, ... }'` validates the agent's JSON response (flat schema; types `string`, `number`, `boolean`) and exports `$name` (raw JSON) plus `$name_field` for each field; invalid JSON or schema violation fails the step. See [Grammar](grammar.md).

- **Send operator** — `echo "data" -> channel` sends content to a named inbox channel; standalone `-> channel` forwards `$1`. The runtime dispatches to workflows registered with `on` routes. See [Inbox & Dispatch](inbox.md).

- **Route declaration** — `on channel -> workflow` registers a static routing rule: when a message arrives on `channel`, call `workflow` with the message as `$1`. Multiple targets (`on ch -> wf1, wf2`) dispatch sequentially. Routes are declarations, not executable steps. See [Inbox & Dispatch](inbox.md).

- **Assignment capture for any step** — `name = ensure ref`, `name = run ref`, and `name = <shell_command>` capture that step's stdout into `name`. Only stdout is captured; stderr is not included unless the command redirects it (e.g. `2>&1`). If the command fails, the step fails unless you add explicit short-circuiting (e.g. `|| true`). See [Grammar](grammar.md).


All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

