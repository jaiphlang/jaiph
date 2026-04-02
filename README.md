# ![Jaiph](docs/logo.png)

[jaiph.org](https://jaiph.org) · [Getting Started](docs/getting-started.md) · [Grammar](docs/grammar.md) · [CLI](docs/cli.md) · [Configuration](docs/configuration.md) · [Testing](docs/testing.md) · [Hooks](docs/hooks.md) · [Inbox & Dispatch](docs/inbox.md) · [Sandboxing](docs/sandboxing.md) · [Reporting](docs/reporting.md) · [Architecture](docs/architecture.md) · [Contributing](docs/contributing.md)

---

**Open Source · Powerful · Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jaiph)](https://www.npmjs.com/package/jaiph)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows. You write **`.jh`** files that combine prompts, rules, scripts, and workflows into executable pipelines. The CLI parses source into an AST, validates references at compile time, and the Node workflow runtime interprets the AST directly.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

## Core components

- **CLI** (`src/cli`) — `jaiph run` / `test` / `format` / `report` / `init` / `use`; spawns the workflow runner, parses live events, runs hooks.
- **Parser** (`src/parser.ts`, `src/parse/*`) — `.jh` / `.test.jh` → AST.
- **Validator** (`src/transpile/validate.ts`) — imports and symbol references at compile time.
- **Transpiler** (`src/transpile/*`) — emits atomic `script` files under `scripts/` only (no workflow-level shell).
- **Node workflow runtime** (`src/runtime/kernel/node-workflow-runtime.ts`, `graph.ts`) — interprets the AST; `buildRuntimeGraph()` is parse-only across imports.
- **Node test runner** (`src/runtime/kernel/node-test-runner.ts`) — `*.test.jh` blocks with mocks.
- **JS kernel** (`src/runtime/kernel/`) — prompts, managed scripts, `__JAIPH_EVENT__`, inbox, mocks.
- **Reporting** (`src/reporting/*`) — reads `.jaiph/runs` and `run_summary.jsonl` for `jaiph report`.

Diagrams, runtime contracts, on-disk artifact layout, and distribution: **[Architecture](docs/architecture.md)**. Test layers and E2E policy: **[Contributing](docs/contributing.md)**.

## Quick try

Run a sample workflow without installing anything first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default() {
  const response = prompt "Say: Hello I'\''m [model name]!"
  log "${response}"
}'
```

Requires `node` and `curl`. The script installs Jaiph automatically if needed.

## Install

```bash
curl -fsSL https://jaiph.org/install | bash
```

Or install from npm:

```bash
npm install -g jaiph
```

Verify: `jaiph --version`. Switch versions: `jaiph use nightly` or `jaiph use 0.6.0`.

## Example

```jaiph
#!/usr/bin/env jaiph

import "tools/security.jh" as security

script check_deps = "test -f \"package.json\""

rule deps_exist() {
  if not run check_deps() {
    fail "Missing package.json"
  }
}

workflow default(task) {
  ensure deps_exist()
  const ts = run script() "date +%s"
  prompt "Build the application: ${task}"
  ensure security.scan_passes()
}
```

```bash
./main.jh "add user authentication"
```

For the full language reference, see [Grammar](docs/grammar.md). For CLI commands, configuration, testing, sandboxing, hooks, and inbox dispatch, see [Getting Started](docs/getting-started.md) or visit [jaiph.org](https://jaiph.org).

## Resources

- [Getting Started](docs/getting-started.md) — install, first run, language overview
- [Examples](https://github.com/jaiphlang/jaiph/tree/main/examples) — runnable `.jh` files matching the landing-page samples
- [Agent skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md) — for AI assistants authoring `.jh` workflows

## Contributing

See [Contributing](docs/contributing.md) for branch strategy, pull requests, the test layers, and code style. Use [GitHub Issues](https://github.com/jaiphlang/jaiph/issues) for bugs and feature discussion.

## License

[Apache License 2.0](LICENSE).
