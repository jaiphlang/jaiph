# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](docs/getting-started.md) · [CLI](docs/cli.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md) · [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md)

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
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI). Use `result = prompt "..." returns '{ type: string, risk: string }'` to validate the agent's JSON response and get typed fields (`$result`, `$result_type`, `$result_risk`, etc.); see [Grammar](docs/grammar.md).
- **Composability** — Import other `.jh` modules and call their rules/workflows by alias.
- **Shell-native** — Transpiled output is bash; you can mix Jaiph primitives with normal shell commands.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- **Documentation:** [Getting started](docs/getting-started.md) — installation, first workflow, workspace setup. Full reference: <https://jaiph.org/>
- **Agent skill (for AI agents):** <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>
- **Samples:** <https://github.com/jaiphlang/jaiph/tree/main/samples>
- **Contributing:** <https://github.com/jaiphlang/jaiph/issues>

## Contributing

The Jaiph project welcomes contributions. Development moves quickly and may include breaking changes. Two primary branches: **main** (stable) and **nightly** (latest).

* If you want to fix a bug, please point your PR to the `main` branch, and also check if the issue has been addressed in the `nightly` branch.
  This ensures that your fix is relevant and not already resolved in ongoing development.
* If you are adding a new feature, submit your PR to the `nightly` branch (and don't forget to add or update tests in `e2e/tests`!).
  Changes from the `nightly` branch are released roughly in a weekly basis.
* We highly recommend creating issues with a thorough description of any bugs or features before submitting code.
  This allows our Jaiph workflows and maintainers to efficiently prioritize, discuss, and track contributions.
* Pull requests generated with the help of AI are welcome, as long as they include comprehensive tests (including in `e2e/tests`).
  Strong test coverage makes it easier to review, merge, and maintain code contributed by both humans and AI.


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
jaiph use 0.3.0     # installs tag v0.3.0
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

Tip: add `.jaiph/` to your `.gitignore`.

### Run reporting and logs

- During `jaiph run`, progress rendering is event-driven.
  - **TTY:** The progress tree is identical to non-TTY: each task line shows icon and final time when the step completes (e.g. `✓ 0s`, `▸ prompt "First 24 chars..." (arg1)` then on completion `✓ 2s`). No per-step live elapsed on tree rows. A single **bottom line** shows `  RUNNING workflow <name> (X.Xs)` (RUNNING yellow, "workflow" bold, workflow name default, time dim) and is the only line updated in place (e.g. every second). When the run completes, that line is removed.
  - **Non-TTY:** One completion line per finished step; no RUNNING line, no in-place updates.
- For parameterized steps (`workflow`, `prompt`, `function`, `rule`), the tree shows passed argument values inline in gray using a uniform `key="value"` format. Positional args display as `1="value"`, `2="value"`, etc.; named args display as `name="value"`. Values are truncated to 32 chars. Multi-line values (newlines, tabs) are collapsed to single spaces. **Prompt** steps additionally show a truncated preview of the prompt text (first 24 chars). The parameter list is capped at 96 characters.
- Each run writes `.jaiph/runs/<timestamp>-<id>/run_summary.jsonl`.
- **Prompt steps** show no output in the tree — only the step line and ✓. To display agent output, use `log` explicitly (e.g. `response = prompt "..."; log "$response"`). The `log` line appears in the tree at the correct depth with the message text.
- Step output is embedded in `STEP_END` events (`out_content`, `err_content` for failures) for error reporting. Embedded content is capped at 1 MB (truncated with `[truncated]` if exceeded). This makes error output identical in Docker and non-Docker modes.
- Step `.out` / `.err` files are written to disk under `.jaiph/runs/` for debugging/archival. Prompt `.out` files contain the full agent transcript (Command, Prompt, Reasoning, Final answer).

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
  runtime.docker_enabled = true
  runtime.docker_image = "ubuntu:24.04"
  runtime.docker_timeout = 300
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
  ]
}
```

Important:

- You can set `agent.backend` to `"cursor"` (default) or `"claude"` per workflow file; `JAIPH_AGENT_BACKEND` overrides it. When backend is `"claude"`, the Anthropic Claude CLI (`claude`) must be on PATH or the run fails with a clear error.
- `agent.trusted_workspace` sets Cursor backend trust scope (`--trust`), defaulting to project root.
- `agent.command` accepts executable + inline args (for example `cursor-agent --force`).
- `agent.cursor_flags` / `agent.claude_flags` append backend-specific CLI flags (split on whitespace).
- Environment variables override config values (for example `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`).
- `runtime.docker_enabled` enables an optional Docker sandbox — the container receives only transpiled bash and the shell stdlib; no Jaiph source or Node.js. See [configuration.md](docs/configuration.md) for mount parsing rules, workspace structure, and Docker behavior details.

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

- `log "message"`
  Displays a message in the progress tree at the current depth and writes to **stdout**. Takes a double-quoted string; shell variable interpolation works at runtime. No spinner, no timing — just a static annotation. See [Grammar](docs/grammar.md).

- `logerr "message"`
  Same as `log`, but writes to **stderr** instead of stdout. In the progress tree, `logerr` lines are displayed with a red `!` instead of the dim `ℹ` used by `log`. See [Grammar](docs/grammar.md).

- `channel <- echo "data"` · `channel <-`
  Sends content to a named inbox channel. The channel identifier is always on the left side of `<-`. The runtime dispatches to workflows registered via route declarations. Standalone `channel <-` forwards `$1`. Combining capture and send (`name = channel <- cmd`) is a parse error. See [Inbox & Dispatch](docs/inbox.md).

- `channel -> workflow` · `channel -> wf1, wf2`
  Declares a static routing rule: when a message arrives on `channel`, the runtime calls the target workflow(s) with the message as `$1`. Multiple targets are dispatched sequentially. Routes are declarations, not executable steps. See [Inbox & Dispatch](docs/inbox.md).

- **Assignment capture** — You can capture stdout from any step with `name = <step>`:
  - `result = prompt "..."` — Captures the agent's stdout (unchanged from before).
  - `result = prompt "..." returns '{ type: string, risk: string }'` — Same, but validates the response as JSON against the schema and exports `$result`, `$result_type`, `$result_risk`, etc. Schema is flat; allowed types: `string`, `number`, `boolean`. Invalid JSON or missing/wrong-type field fails the step. See [Grammar](docs/grammar.md).
  - `response = ensure ref` — Captures the rule's stdout into `$response`.
  - `out = run ref` — Captures the workflow's stdout into `$out`.
  - `line = <shell_command>` — Captures the command's stdout into `$line`.
  Capture is **stdout only**; stderr is not included unless the command redirects it (e.g. `2>&1`). If the command fails, the step fails unless you explicitly short-circuit (e.g. `... || true`). See [Grammar](docs/grammar.md).

All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

## More Documentation

- [Getting started](docs/getting-started.md) — installation, first workflow, workspace setup
- [Agent skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) — guide for AI agents that generate or modify Jaiph workflows
- Full docs: <https://jaiph.org/>
- [CLI reference](docs/cli.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md)
