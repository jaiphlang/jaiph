# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](https://jaiph.org/getting-started) ([`docs/getting-started.md`](docs/getting-started.md)) · [CLI](docs/cli.md) · [Reporting](docs/reporting.md) · [Configuration](docs/configuration.md) · [Grammar](docs/grammar.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md) · [Sandboxing](docs/sandboxing.md) · [Agent skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) · [Contributing](docs/contributing.md)

---

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to bash that sources a small runtime stdlib. **Prompt** steps, **managed step subprocesses** (`run` / `ensure` / nested rule and workflow children, plus emitted **`script`** executables), **file-backed inbox** (init / send / routes / drain under `.jaiph/runs` via `kernel/inbox.js`), and **stderr `__JAIPH_EVENT__` / `run_summary.jsonl` emission** (via `kernel/emit.js`) run through a **bundled Node.js kernel** under `src/runtime/kernel/`; workflow orchestration and most other stdlib logic stay in Bash. **`jaiph test`** drives **`*.test.jh`** files through that same stack under **`JAIPH_TEST_MODE`**, so mocks and assertions stay aligned with **`jaiph run`** without new authoring rules. User **`script`** bodies are still normal child processes (bash or another shebang). That keeps workflows portable while reusing familiar shell entrypoints.

**Features:**

- **Workflows** — Ordered **Jaiph-only** steps (`ensure`, `run`, `prompt`, `const`, brace `if`, `fail`, `return`, `log` / `logerr`, inbox `send` / `route`, async `run … &` + `wait`). Anything that is not a recognized step is a parse error: move bash into a **`script`** and call it with **`run`**. Conditionals use **brace form only** (`if [not] ensure|run ref { … }`).
- **Rules** — Reusable checks as **structured steps** (same keyword style, restricted set): `ensure` for other rules, **`run` for scripts only**, `const`, brace `if`, `fail`, `log` / `logerr`, `return "…"`. No `prompt`, inbox, `wait`, or `ensure … recover`. Used with `ensure` and in conditionals.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI). Supports validated JSON responses via `returns '{ field: type }'`.
- **Composability** — Import other `.jh` modules and call their rules, workflows, and scripts by alias. **Managed calls only:** `ensure` for rules, `run` for workflows and scripts. Assignment capture (`x = ensure …`, `x = run …`, or `const x = …`) uses each callee’s **value channel** (explicit `return "…"` in rules/workflows; **scripts** pass data via **stdout**). In **`const`** bindings, call-like capture must use the keyword explicitly (**`const x = run script "$arg"`**, not **`const x = script "$arg"`**). Do not wrap Jaiph callees in `$(...)` or invoke them as bare bash commands.
- **Shell-native (and polyglot)** — Transpiled output is bash. Use **`script`** blocks for command pipelines, tests, and helpers (bash `return` / `exit` only — not Jaiph `return "…"` or `fail` / `log` / `logerr` / `const` inside those bodies). **Script isolation:** scripts execute in a clean process environment (`env -i`) — only positional arguments, essential system variables, and Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are inherited. Module-scoped `const` / `local` values are visible in rules and workflows but **not** in scripts; pass data as arguments or use shared libraries (`source "$JAIPH_LIB/…"`). Scripts cannot call other Jaiph scripts — compose through workflows instead. **Polyglot scripts:** add a custom shebang (e.g. `#!/usr/bin/env node` or `#!/usr/bin/env python3`) as the first body line to write scripts in other languages — Jaiph keyword validation is skipped for non-bash shebangs. Scripts are emitted as separate executable files under `build/scripts/`. Generated scripts default **`JAIPH_LIB`** to `<workspace>/.jaiph/lib` (via `JAIPH_WORKSPACE`) so `source "$JAIPH_LIB/…"` resolves predictably. See [Grammar](docs/grammar.md), [CLI environment variables](docs/cli.md#environment-variables), and `.jaiph/language_redesign_spec.md` for the orchestration vs execution boundary.

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

script file_exists() {
  test -f "$1"
}

script non_empty() {
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

script npm_run_build() {
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

Transpiled output is standard bash and sources the installed global Jaiph runtime stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`). The same install bundles the kernel scripts (`kernel/prompt.js`, `kernel/run-step-exec.js`, `kernel/inbox.js`, `kernel/emit.js`, …) next to the stdlib so managed prompts, step subprocesses, inbox transport, and progress/summary event emission stay version-locked with the CLI.

## Getting Started

### Quick try

Run a sample workflow without installing anything first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log "$response"
}'
```

The script installs Jaiph automatically if it is not already on your `PATH`. Requires `node` and `curl`.

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

When stdout is not a terminal (for example in CI), long-running steps can print periodic gray **heartbeat** lines between the start and completion markers so logs show the run is still active. See [CLI Reference — Run progress and tree output](docs/cli.md#run-progress-and-tree-output) for heartbeats, tree formatting, and **`log` / `logerr`** (terminal output uses **`echo -e`**-style escapes; `LOG` / `LOGERR` JSON keeps the raw message string).

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
