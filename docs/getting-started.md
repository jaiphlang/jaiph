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

It combines declarative workflow structure with script execution, and the **Node workflow runtime** (`NodeWorkflowRuntime`) interprets the AST directly — no Bash transpilation on the runtime path. **`jaiph run`** and **`jaiph test`** parse `.jh` sources, build a runtime graph, and execute through the Node workflow runtime. The CLI spawns the workflow runner as a detached process and owns signals and the child process group. **Prompt** handling, **managed step subprocesses** (each `run` / `ensure` child, including **`script`** blocks), **inbox** file I/O, and **event emission** (`__JAIPH_EVENT__` / `run_summary.jsonl`) are all handled by the **JS kernel** under **`runtime/kernel/`**. Your **`script`** bodies still run as ordinary processes (default bash or a custom shebang).

**Core concepts:**

- **Workflows** — Ordered **Jaiph-only** steps (`ensure`, `run`, `prompt`, `const`, brace `if`, `fail`, `return`, logging, inbox, async `run … &` + `wait`). Unrecognized lines are parse errors — put bash in **`script`** blocks and call them with **`run`**. Conditionals use **brace form** only (`if [not] ensure|run ref { … }`).
- **Rules** — Structured checks with the same keyword style (restricted set): `ensure` for rules, **`run` for scripts only**, `const`, brace `if`, `fail`, `log` / `logerr`, `return "…"`; no `prompt`, inbox, `wait`, or `ensure … recover`.
- **Agent prompts** — `prompt "..."` sends text to a configured agent (e.g. Cursor or Claude CLI); workflows orchestrate when the agent runs.
- **Composability** — Import other `.jh` modules and call their rules, workflows, and scripts by alias (e.g. `ensure security.scan_passes`, `run bootstrap.nodejs`). Use **`ensure` only for rules** and **`run` for workflows and scripts** so every managed call is keyword-led.
- **Step capture** — Assign results with `x = ensure …` / `x = run …` / `x = prompt …`, or **`const x = …`** with the same RHS forms (see [Grammar](grammar.md)). For **rules and workflows**, capture uses explicit `return "…"` / `return "$var"`. For **`run` to a script**, capture follows **script stdout** (use `echo` / `printf` — not Jaiph `return "…"` inside the script body). With **`const`**, use **`run`** / **`ensure`** explicitly for call-like RHSs (**`const x = run fn "$arg"`**, not **`const x = fn "$arg"`**).
- **Shell-native scripts** — `script` blocks hold bash (or any language via a custom shebang) and execute as managed subprocesses. Shared bash helpers can live in `.jaiph/lib/` and be loaded from scripts with `source "$JAIPH_LIB/…"`. The runtime sets `JAIPH_LIB` under the workspace; see [CLI — Environment variables](cli.md#environment-variables).

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

script file_exists() {
  test -f "$1"
}

script non_empty() {
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

script npm_run_build() {
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

When you run a workflow via **`jaiph run`**, **`jaiph ./file.jh`**, or a `#!/usr/bin/env jaiph` shebang, the Node workflow runtime interprets the parsed AST directly. Script steps execute as managed subprocesses. The **`runtime/kernel/`** modules handle prompt execution, inbox transport, event emission, and step management. Advanced overrides are documented under [Environment variables](cli.md#environment-variables).

A runnable copy of this example lives in the Jaiph repository under `test/fixtures/` (with stub modules `bootstrap_project.jh` and `tools/security.jh`).

## Quick try

Run a sample workflow without installing anything first — the script installs Jaiph automatically if it is not already on your `PATH`:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log "$response"
}'
```

Requires `node` and `curl`. If Jaiph is already installed, the script skips installation and runs the workflow directly.

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
Installation places the `jaiph` CLI in `~/.local/bin/`.

## Running a workflow

```bash
./path/to/main.jh "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: the entry file must define a workflow named **`default`**. Executable `.jh` files with `#!/usr/bin/env jaiph` run that workflow when invoked as `./file.jh` (the `jaiph` binary must be on your **`PATH`**). The same applies to **`jaiph run path/to/file.jh`** and the shorthand **`jaiph path/to/file.jh`** when the path exists.

Other useful CLI commands:

```bash
jaiph test [path]                     # run tests (see below)
jaiph report --workspace .            # browse .jaiph/runs in a local dashboard
```

**`jaiph test`:** With no path, Jaiph discovers every `*.test.jh` under the workspace root: walk **up** from the current working directory until a directory containing `.jaiph` or `.git` is found; if neither exists on that path, the root is the resolved cwd. Pass a directory to run all tests under it (workspace root is detected the same way, starting from that path). Pass a single `*.test.jh` file to run one suite. See [Testing](testing.md).

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

Jaiph source files use the **`.jh`** extension. A file contains **rules**, **workflows**, **scripts**, and optional **config** blocks. All primitives interoperate with standard bash via `script` blocks. For the full grammar and validation rules, see [Grammar](grammar.md).

- `config { ... }` — Optional block setting runtime options (agent backend, model, Docker sandbox, etc.). Allowed at the top level (module-wide) and inside individual workflows for per-workflow overrides (`agent.*` and `run.*` keys only). See [Configuration](configuration.md).
- `import "path" as alias` — Import rules, workflows, and scripts from another module. The path may include a `.jh` suffix or omit it (the compiler appends `.jh`). Verified at compile time.
- `local name = value` / `const name = value` — Module-scoped variable, accessible as `$name` in rules and workflows within the module (scripts are isolated and do not inherit these — pass data as arguments or use shared libraries). Prefer **`const`** in new orchestration code.
- `rule name { ... }` — Reusable check: **Jaiph structured steps only** (subset: `ensure` for rules, `run` for **scripts**, `const`, brace `if`, `fail`, `log`/`logerr`, `return "…"`). Rules run in an isolated child shell; on Linux, a read-only mount namespace is used when `unshare` and passwordless `sudo` are available, otherwise the same child-shell fallback as on other platforms. Optional `export` for cross-module access.
- `workflow name { ... }` — Orchestration entrypoint: **Jaiph steps only** (no raw shell — extract bash to `script` + `run`). Can change system state. Optional `export` for cross-module access.
- `script name { ... }` — Bash helper (no `run`/`ensure`/routes; no Jaiph `fail`/`const`/`log`/`logerr`/`return "…"`). From a **workflow** or **rule**, call with **`run name`**; string capture uses **stdout**. The `()` after the name is optional (`script name() { ... }` also works). **Isolation:** Scripts run in a clean environment — they receive only positional arguments and essential system / Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`); module-scoped `local` / `const` are **not** inherited. Use `source "$JAIPH_LIB/…"` for shared utilities. Scripts cannot call other Jaiph scripts (compose in a workflow instead). **Polyglot scripts:** if the first body line is a shebang (e.g. `#!/usr/bin/env node`), the script is emitted with that interpreter and Jaiph keyword validation is skipped. Without a shebang, `#!/usr/bin/env bash` is used. Scripts are compiled as separate executable files under `build/scripts/`.
- `ensure ref [args...]` — Execute a rule; optional `recover` for bounded retry loops (default max retries **10**, overridable with **`JAIPH_ENSURE_MAX_RETRIES`**). See [Grammar](grammar.md).
- `run ref [args...]` — In a **workflow**, run another workflow or a script. In a **rule**, run a **script** only.
- `prompt "..."` — Send text to the configured agent. Optional `returns '{ field: type }'` for validated JSON responses. See [Grammar](grammar.md).
- `name = <step>` / `const name = <step>` — Capture or bind: for **`ensure`** and **`run` to a workflow**, the callee’s explicit **`return "…"`**; for **`run` to a script**, **stdout**; for **`prompt`**, the final answer; **`const`** RHS allows only simple value forms (no `$(...)` — use `run` to a script). To capture from a script or workflow in a **`const`**, write **`const x = run ref [args…]`** (or **`ensure`** for rules) — a bare **`const x = ref [args…]`** is a compile error with a hint to add **`run`**. See [Grammar](grammar.md#step-output-contract).
- `fail "reason"` — Abort the workflow or fail the rule with a message on stderr (non-zero exit).
- `log "message"` / `logerr "message"` — Display a message in the progress tree and on stdout/stderr; terminal output interprets backslash escapes like **`echo -e`** (`\n`, `\t`, …). Event and summary JSON still record the raw message string.
- `channel <- …` / `channel -> workflow` — Send (RHS: literal, `$var`, or `run fn`) and route messages between workflows. See [Inbox & Dispatch](inbox.md).
- `run ref &` / `wait` — Background managed runs and join with a **`wait`** step. Use **`script`** + **`run`** for bash background jobs. See [Grammar](grammar.md).
- `if [not] ensure ref { ... }` / `if [not] run ref { ... }` — **Brace-only** conditionals (`else if`, `else` supported). Use **`run`** to a script for command-style tests.

### Named parameters

Workflows, rules, and scripts support named parameters with optional defaults:

```jaiph
script check_hash(file_path, expected_hash) { ... }
workflow deploy(env, version, dry_run = "false") { ... }
```

Named params map to positional arguments at runtime (e.g. `file_path` binds to `$1`). Default values use fallback expansion (`"${3:-false}"`). Parentheses are optional when no params exist. See [Grammar — Named parameters](grammar.md#named-parameters).

### Polyglot scripts

Scripts default to bash. Add a custom shebang as the first body line to use another language:

```jaiph
script analyze() {
  #!/usr/bin/env python3
  import sys
  print(f"Result: {sys.argv[1]}")
}
```

Non-bash scripts skip Jaiph keyword validation. See [Grammar — Polyglot scripts](grammar.md#polyglot-scripts-and-custom-shebangs).

### Module-qualified references

Imported symbols use **dot notation**: `alias.name` (e.g. `ensure security.scan_passes`, `run bootstrap.nodejs`). The compiler validates that the target exists and matches the calling keyword.

### Inline capture

`run` and `ensure` can appear inline in binding and send expressions — not only as standalone steps:

```jaiph
const result = run helper "$arg"       # capture script stdout into const
check = ensure validator "$input"      # capture rule return value
answer = prompt "Summarize" returns '{ summary: string }'

channel <- run build_message "$data"   # send script output to channel
```

For **typed prompts** (`returns '{ field: type }'`), the runtime validates the agent's JSON and exposes per-field variables: `$answer_summary` in the example above. See [Grammar — Step output contract](grammar.md#step-output-contract).

### Script naming

Every `script` block requires an explicit name — anonymous (unnamed) script blocks are not supported. Extract reusable bash into named scripts and call them with `run`:

```jaiph
script check_port() { nc -z localhost "$1"; }
workflow default { if not run check_port "8080" { fail "port closed" } }
```

Runtime behavior (progress tree, step output, run logs) is documented in [CLI Reference](cli.md). To browse past and in-progress runs in a browser, use [Reporting server](reporting.md). For agent backend configuration, see [Configuration](configuration.md). For Docker sandboxing (beta), see [Sandboxing](sandboxing.md). For testing workflows with mocks and assertions, see [Testing](testing.md). For lifecycle hooks, see [Hooks](hooks.md).
