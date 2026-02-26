# ![Jaiph](logo.png)

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/main/docs/jaiph-skill.md)

---

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

[jaiph.org](https://jaiph.org)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs (canonical): <https://jaiph.org/>
- Agent skill: <https://raw.githubusercontent.com/jaiphlang/jaiph/main/docs/jaiph-skill.md>
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

This creates `.jaiph/bootstrap.jh`, `.jaiph/config.toml`, and `.jaiph/jaiph-skill.md` (synced from your installed Jaiph copy).

Then run:

```bash
./.jaiph/bootstrap.jh
```

This asks an agent to detect project configuration and bootstrap recommended Jaiph workflows for feature implementation.

Tip: add `.jaiph/runs/` to your `.gitignore`.

### Run reporting and logs

- During `jaiph run`, progress rendering is event-driven.
  - TTY: one live running step line + committed step completion lines.
  - Non-TTY: one completion line per finished step.
- Each run writes `.jaiph/runs/<timestamp>-<id>/run_summary.jsonl`.
- Step `.out` / `.err` files are created only when the step produced output (empty log files are skipped).

### Configuration

Jaiph supports both global and local TOML config files:

- Global: `${XDG_CONFIG_HOME:-~/.config}/jaiph/config.toml`
- Local: `.jaiph/config.toml` (in your workspace)

Local config overrides global config. See [configuration.md](configuration.md) for full details and examples.

### CLI reference

See [cli.md](cli.md) for command syntax, examples, and supported environment variables.

## Language Primitives

- `import "file.jph" as alias`  
  Imports rules/workflows from another Jaiph module under an alias. Imports are verified at compile time.

- `rule name { ... }`  
  Defines a reusable check/action that returns a shell exit code. Rules run in a read-only subshell and preserve stdout. Rules can consume positional parameters (`$1`, `$2`, `"$@"`) forwarded by `ensure`.

- `workflow name { ... }`  
  Defines an orchestration entrypoint made of ordered steps. Workflows can change system state.

- `function name() { ... }`  
  Defines a reusable writable shell function. Functions can be called from workflows/rules and are tracked as regular Jaiph steps.

- `ensure ref [args...]`  
  Executes a rule in a workflow or another rule, optionally forwarding arguments (for example: `ensure my_rule "$1"`).

- `run ref`  
  Executes another workflow from a workflow. `run` is not allowed inside a rule; use `ensure` to call another rule or move the call to a workflow.

- `prompt "..."`  
  Sends prompt text to the configured agent command.

All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Parser limitation: inline brace-group short-circuit patterns like `cmd || { ... }` are not supported in `.jh`/`.jph` files yet. Use explicit conditionals like `if ! cmd; then ...; fi` instead.
- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

## More Documentation

- Full docs: <https://jaiph.org/>
- Grammar: [grammar.md](grammar.md)
- Agent bootstrap skill: [jaiph-skill.md](jaiph-skill.md)
- Configuration: [configuration.md](configuration.md)
- CLI: [cli.md](cli.md)
