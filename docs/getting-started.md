---
title: Getting started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

Jaiph is a composable scripting language and runtime for AI agent workflows. You write `.jh` files that combine prompts, rules, scripts, and workflows into executable pipelines. The CLI parses source into an AST, validates references at compile time, and the Node workflow runtime interprets the AST directly. This page covers installation, running your first workflow, workspace setup, and a map of the language.

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

This installs Jaiph to `~/.local/bin`. Alternatively, install from npm:

```bash
npm install -g jaiph
```

Verify with:

```bash
jaiph --version
```

If the command is not found, ensure `~/.local/bin` (installer) or the npm global bin directory is in your `PATH`.

Switch versions at any time:

```bash
jaiph use nightly
jaiph use 0.8.0
```

## Quick try

Run a sample workflow without installing first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log response
}'
```

The script installs Jaiph automatically if it is not already on your `PATH`. Requires `node` and `curl`.

For more runnable samples (inbox, async, testing, ensure/recover), see the [`examples/`](https://github.com/jaiphlang/jaiph/tree/main/examples) directory.

## Running a workflow

Jaiph workflows are `.jh` files. Every workflow file needs a `workflow default` as its entry point. Run it directly (with a shebang) or through the CLI:

```bash
./path/to/main.jh "feature request or task"
# or explicitly:
jaiph run ./path/to/main.jh "feature request or task"
```

Arguments are bound to **named parameters** declared on the default workflow (e.g. `workflow default(task)` → `${task}`). In script bodies, standard shell positional parameters apply (`$1`, `$2`, `"$@"`).

### Run artifacts

Each run writes artifacts under `.jaiph/runs/<date>/<time>-<source>/`:

- `*.out` / `*.err` — stdout and stderr capture per step
- `run_summary.jsonl` — append-only JSONL event timeline (workflow boundaries, step start/end, log, inbox events)
- `inbox/` — inbox message files (when channels are used)

Add `.jaiph/runs/` to your `.gitignore`.

### Reporting

View run history, step trees, and logs in a local web UI:

```bash
jaiph report --workspace .
```

See [Reporting](reporting.md) for details.

### Formatting

Enforce consistent style across `.jh` files:

```bash
jaiph format flow.jh           # rewrite in place
jaiph format --check *.jh      # CI-safe: exits 1 when changes needed
jaiph format --indent 4 flow.jh
```

See [CLI — `jaiph format`](cli.md#jaiph-format) for all options.

## Workspace setup

### Initialize with `jaiph init`

```bash
jaiph init
```

This creates a `.jaiph/` directory in your project root with:

- `.jaiph/bootstrap.jh` — an interactive workflow that asks an agent to scaffold recommended workflows for your project
- `.jaiph/jaiph-skill.md` — the agent skill file for AI assistants authoring `.jh` workflows

Run the bootstrap workflow to get started:

```bash
./.jaiph/bootstrap.jh
```

### Workspace convention

By convention, keep Jaiph workflow files in `<project_root>/.jaiph/` so workspace-root detection and agent setup stay predictable. Jaiph resolves `JAIPH_WORKSPACE` to the project root and `JAIPH_LIB` to `<workspace>/.jaiph/lib` for shared script libraries.

## Language overview

Jaiph source files combine a small orchestration language with scripts in any language. The four core building blocks:

**workflow** — Ordered steps that orchestrate rules, scripts, prompts, and other workflows. Must use Jaiph keywords only (no raw shell lines). Every file needs a `workflow default` entry point.

**rule** — Reusable checks composed of structured steps (`ensure`, `run`, `const`, `if`, `fail`, `return`, `log`). Called with `ensure` from workflows.

**script** — Shell (or polyglot) code definitions that execute as isolated subprocesses. Called with `run` from workflows and rules. Named scripts use backtick delimiters: `` script name = `body` `` for single-line or `` script name = ```lang ... ``` `` for multi-line. Use fence lang tags (`` ```node ``, `` ```python3 ``, `` ```ruby ``, etc.) to select an interpreter — the tag maps directly to `#!/usr/bin/env <tag>` (any tag is valid, no hardcoded allowlist). If no tag is present, add a manual `#!` shebang as the first body line. Scripts receive only positional arguments (`$1`, `$2`, …) and essential Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`). Jaiph interpolation (`${...}`) is forbidden in **single-line backtick** script bodies to prevent ambiguity with shell variables; fenced (triple-backtick) blocks allow `${...}` — it passes through as standard shell parameter expansion. For trivial one-off commands, use **inline scripts**: `` run `echo ok`() `` or fenced blocks (`` run ```...```(args) ``) — no named `script` definition needed.

**prompt** — Sends text to a configured AI agent. The body can be a single-line `"string"`, a bare identifier (`prompt myVar`), or a triple-quoted `"""` block for multiline text. Triple backticks are reserved for scripts and rejected in prompt context. Supports structured JSON responses via `returns "{ field: type }"`.

**Type distinction** — `string` and `script` are separate primitive types enforced at compile time. Strings are promptable and interpolatable; scripts are executable with `run`. Crossing these boundaries (e.g. `prompt scriptName`, `run stringConst()`, `const x = scriptName`, `${scriptName}`) produces an `E_VALIDATE` error. See [Grammar — Types](grammar.md#types).

**String quoting** — Jaiph uses a four-delimiter system. `"..."` is the single-line string form; `"""..."""` is the multiline string form. Both support `${...}` interpolation. A double-quoted string that spans multiple lines is rejected — use triple quotes instead. Script bodies use backtick (`` ` ``) for single-line and triple backtick (`` ``` ``) for multi-line.

### Key patterns

- `ensure rule` / `ensure rule()` — run a rule as a check (parentheses optional for zero-arg calls)
- `run workflow` / `run script_name` — call a workflow or script (parens optional when no args)
- `run greet(name)` — bare identifier arg, equivalent to `run greet("${name}")` (parens required when args present)
- `` run `echo ok`() `` — inline script for trivial one-off commands
- `run async workflow()` — concurrent execution with implicit join
- `const x = prompt "..." returns "{ field: type }"` — structured capture with `${x.field}` access; `number` / `boolean` in the schema validate JSON but each field is **stored as a string** in workflow scope (orchestration is text-only)
- `return run workflow` / `return ensure rule` — direct return from a managed call (parens optional)
- `ensure rule() recover (failure) { ... }` — bounded self-healing retries with explicit bindings
- `channel name [-> workflow]` / `ch <- "msg"` — inter-workflow messaging (routes declared inline on channel)
- `import "file.jh" as alias` — module composition

### Example

```jaiph
#!/usr/bin/env jaiph

script check_deps = `test -f "package.json"`

rule deps_exist() {
  if not run check_deps() {
    fail "Missing package.json"
  }
}

workflow default(task) {
  ensure deps_exist()
  prompt "Implement the feature: ${task}"
}
```

```bash
./main.jh "add user authentication"
```

## Further reading

- [Grammar](grammar.md) — full language reference
- [CLI Reference](cli.md) — commands, flags, environment variables
- [Configuration](configuration.md) — `config` blocks, agent backends, runtime options
- [Testing](testing.md) — `*.test.jh` suites, mocks, assertions
- [Hooks](hooks.md) — lifecycle event automation
- [Inbox & Dispatch](inbox.md) — channel messaging between workflows
- [Sandboxing](sandboxing.md) — Docker isolation
- [Reporting](reporting.md) — run history web UI
- [Architecture](architecture.md) — system structure, execution flow, contracts
- [Contributing](contributing.md) — development setup, testing philosophy
