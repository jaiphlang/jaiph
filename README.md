# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Your first workflow](docs/first-workflow.md) · [Your first agent + sandboxed run](docs/first-agent-run.md) · [Install & switch versions](docs/setup.md) · [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) · [Architecture](docs/architecture.md) · [CLI](docs/cli.md) · [Contributing](docs/contributing.md)

> **Docs note:** The Jaiph documentation site follows the [Diátaxis](https://diataxis.fr/) framework. Tutorials: [Your first workflow](docs/first-workflow.md), [Your first agent + sandboxed run](docs/first-agent-run.md). How-to: [Install & switch versions](docs/setup.md), [Run in a Docker sandbox](docs/sandbox-run.md), [Authenticate agent backends](docs/agent-auth.md), [Configure backend & model](docs/configure-backend.md), [Add a hook](docs/hooks.md), [Use & publish a library](docs/libraries.md), [Save artifacts](docs/artifacts.md), [Write & run tests](docs/testing.md), [Serve workflows as MCP tools](docs/mcp.md). Reference: [CLI](docs/cli.md), [Configuration](docs/configuration.md), [Grammar](docs/grammar.md), [Language](docs/language.md), [Environment variables](docs/env-vars.md). Explanation: [Why Jaiph](docs/why-jaiph.md), [Architecture](docs/architecture.md), [Sandboxing](docs/sandboxing.md), [Inbox & Dispatch](docs/inbox.md), [Async Handles](docs/spec-async-handles.md). Contributor: [Contributing](docs/contributing.md), [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md).

---

**Open Source · Powerful · Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jaiph)](https://www.npmjs.com/package/jaiph)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows. You write **`.jh`** files that combine prompts, rules, scripts, and workflows into executable pipelines. The CLI parses source into an AST, validates references at compile time, and the Node workflow runtime interprets the AST directly.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

## Features

- **Workflows** — Compose `prompt`, `run`, `ensure`, channel sends, conditionals, `run async` with implicit join, `catch`, and repair-and-retry `recover`.
- **Rules and scripts** — Rules stay structured (no raw shell lines); **`script`** steps run bash or polyglot code as subprocesses.
- **Agents** — Backends include Cursor, Claude, Codex (HTTP), or a custom `agent.command`.
- **Testing** — `*.test.jh` files run in-process (`jaiph test`) with mocks and `expect_*` assertions ([Write & run tests](docs/testing.md)).
- **Safety and inspectability** — Docker-backed sandbox for **`jaiph run`** (env-controlled; see [Sandboxing](docs/sandboxing.md) and [Run in a Docker sandbox](docs/sandbox-run.md)); live **`__JAIPH_EVENT__`** on stderr and durable **`.jaiph/runs/`** artifacts ([Architecture](docs/architecture.md)).
- **Tooling** — `jaiph compile`, `jaiph format`, `jaiph install` / `.jaiph/libs/` ([Use & publish a library](docs/libraries.md)), and optional `hooks.json` ([CLI](docs/cli.md), [Add a hook](docs/hooks.md)).
- **MCP server** — `jaiph mcp ./tools.jh` serves a file's workflows as [MCP](https://modelcontextprotocol.io/) tools over stdio, so any MCP client (Claude Code, Cursor) can call tested Jaiph workflows as tools ([Serve workflows as MCP tools](docs/mcp.md)).

## Core components

- **CLI** (`src/cli`) — `jaiph run` / `test` / `compile` / `format` / `init` / `install` / `use` / `mcp`; prepares scripts, spawns the workflow runner (or in-process test runner), parses `__JAIPH_EVENT__` on stderr, runs hooks on `jaiph run` only.
- **Parser** (`src/parser.ts`, `src/parse/*`) — `.jh` / `.test.jh` → AST.
- **Validator** (`src/transpile/validate.ts`) — imports and symbol references at compile time.
- **Transpiler** (`src/transpile/*`) — emits atomic `script` files under `scripts/` only (no workflow-level shell).
- **Node workflow runtime** (`src/runtime/kernel/node-workflow-runtime.ts`, `graph.ts`) — interprets the AST; `buildRuntimeGraph(graph)` consumes the `ModuleGraph` produced by `loadModuleGraph` (no filesystem reads).
- **Node test runner** (`src/runtime/kernel/node-test-runner.ts`) — `*.test.jh` blocks with mocks.
- **JS kernel** (`src/runtime/kernel/`) — prompts, managed scripts, `__JAIPH_EVENT__`, inbox, mocks.
Diagrams, runtime contracts, on-disk artifact layout, and distribution: **[Architecture](docs/architecture.md)**. Test layers and E2E policy: **[Contributing](docs/contributing.md)**.

## Quick try

Run a sample workflow without installing anything first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log response
}'
```

Requires `node` and `curl`. The script installs Jaiph automatically if needed.

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

On Windows, install with PowerShell instead (installs `jaiph-windows-x64.exe` to `%LOCALAPPDATA%\jaiph\bin`):

```powershell
irm https://jaiph.org/install.ps1 | iex
```

Or install from npm:

```bash
npm install -g jaiph
```

Verify: `jaiph --version`. Switch versions: `jaiph use nightly` or `jaiph use 0.11.0`.

Releases ship a `SHA256SUMS` file plus a detached [minisign](https://jedisct1.github.io/minisign/) signature (`SHA256SUMS.minisig`); the installer verifies the checksum and, when `minisign` and the project public key are available, the signature — see [Verify the release signature](docs/setup.md#verify-the-release-signature).

Initialize a project (optional): `jaiph init` writes `.jaiph/` with bootstrap workflow, gitignore entries for runs/tmp, and **`SKILL.md`**. The CLI resolves the skill body in this order — `JAIPH_SKILL_PATH`, install-relative `jaiph-skill.md`, `docs/jaiph-skill.md` under cwd, then an **embedded copy baked into the binary** as the final fallback — so `jaiph init` always writes `SKILL.md` (see [Install & switch versions](docs/setup.md)). Canonical skill text for agents: `https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md`.

## Usage

- Run the default workflow: `jaiph run path/to/main.jh [args...]` or `./main.jh [args...]` with a `#!/usr/bin/env jaiph` shebang.
- Run tests: `jaiph test` (workspace), `jaiph test ./dir`, or `jaiph test path.test.jh`.
- Validate without executing: `jaiph compile …` (same `validateReferences` checks as before `jaiph run`; no `scripts/` emission — see [Architecture](docs/architecture.md)).
- Format sources: `jaiph format …` / `jaiph format --check …`.

Full flags and environment variables: [CLI](docs/cli.md), [Environment variables](docs/env-vars.md). New here? Start with [Your first workflow](docs/first-workflow.md).

## Example

```jaiph
#!/usr/bin/env jaiph

script check_deps = `test -f "package.json"`

rule deps_exist() {
  run check_deps() catch (err) {
    fail "Missing package.json"
  }
}

workflow default(task) {
  ensure deps_exist()
  const ts = run `date +%s`()
  prompt "Build the application: ${task}"
}
```

```bash
./main.jh "add user authentication"
```

For the full language reference, see [Grammar](docs/grammar.md) and [Language](docs/language.md). For install, libraries, sandboxing, hooks, testing, and artifacts, see the How-to quadrant: [Install & switch versions](docs/setup.md), [Use & publish a library](docs/libraries.md), [Run in a Docker sandbox](docs/sandbox-run.md), [Add a hook](docs/hooks.md), [Write & run tests](docs/testing.md), [Save artifacts](docs/artifacts.md). New to Jaiph? Start with the tutorials: [Your first workflow](docs/first-workflow.md) and [Your first agent + sandboxed run](docs/first-agent-run.md). Or visit [jaiph.org](https://jaiph.org).

## Start here

- **AI agent** who wants to work in a predictable, structured way? Read the [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) — it teaches you how to author Jaiph workflows and makes your behavior verifiable and auditable.
- **Human** who manages agents and wants reliable, repeatable automation? See the [Samples](https://github.com/jaiphlang/jaiph/tree/main/examples) and [Your first workflow](docs/first-workflow.md).
- **Contributor** who wants to improve Jaiph itself? See [Contributing](docs/contributing.md).

## Contributing

See [Contributing](docs/contributing.md) for branch strategy, pull requests, the test layers, and code style. Use [GitHub Issues](https://github.com/jaiphlang/jaiph/issues) for bugs and feature discussion.

## License

[Apache License 2.0](LICENSE).
