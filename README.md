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

## Quick try

Run a sample workflow without installing anything first:

```bash
curl -fsSL https://jaiph.org/run | bash -s '
workflow default {
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

script check_deps {
  test -f "package.json"
}

rule deps_exist {
  if not run check_deps() {
    fail "Missing package.json"
  }
}

workflow default {
  ensure deps_exist()
  const ts = run script("date +%s")
  prompt "Build the application: ${arg1}"
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
