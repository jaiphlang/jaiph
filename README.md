# ![Jaiph](docs/logo.png)

**Open Source • Powerful • Friendly**

[![CI](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml/badge.svg)](https://github.com/jaiphlang/jaiph/actions/workflows/ci.yml)

[jaiph.org](https://jaiph.org)

## What is Jaiph?

**Jaiph** is a composable scripting language and runtime for defining and orchestrating AI agent workflows.

It combines declarative workflow structure with bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs (canonical): <https://jaiph.org/>
- Agent skill: <https://github.com/jaiphlang/jaiph/blob/main/docs/jaiph-skill.md>
- Samples: <https://github.com/jaiphlang/jaiph/tree/main/samples>
- Contribute: <https://github.com/jaiphlang/jaiph/issues>

## Example

`main.jph`:

```jaiph
#!/usr/bin/env jaiph

import "bootstrap_project.jph" as bootstrap
import "tools/security.jph" as security

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
jaiph use 0.2.3     # installs tag v0.2.3
```

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).
Installation places both `jaiph` and global runtime stdlib at `~/.local/bin/jaiph_stdlib.sh`.

### Running a workflow

```bash
./path/to/main.jph "feature request or task"
```

Arguments are passed exactly like bash scripts (`$1`, `$2`, `"$@"`).

Entrypoint resolution: executable `.jph` files (with `#!/usr/bin/env jaiph`) run `workflow default`.  
`jaiph run path/to/file.jph` is also supported and follows the same argument semantics.

### Initialize Jaiph workspace

```bash
jaiph init
```

This creates `.jaiph/bootstrap.jph`, `.jaiph/config.toml`, and `.jaiph/jaiph-skill.md` (synced from your installed Jaiph copy).

Then run:

```bash
./.jaiph/bootstrap.jph
```

This asks an agent to detect project configuration and bootstrap recommended Jaiph workflows for feature implementation.

Tip: add `.jaiph/runs/` to your `.gitignore`.

### Configuration

Jaiph supports both global and local TOML config files:

- Global: `${XDG_CONFIG_HOME:-~/.config}/jaiph/config.toml`
- Local: `.jaiph/config.toml` (in your workspace)

Local config overrides global config. See `docs/configuration.md` for full details and examples.

### CLI reference

See `docs/cli.md` for command syntax, examples, and supported environment variables.

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
  Executes another workflow from a workflow. Inside a rule, `run` is treated as a shell command shorthand.

- `prompt "..."`  
  Sends prompt text to the configured agent command.

All Jaiph primitives can be combined with bash code and are interoperable with normal shell scripting.

Known limitations and gotchas:

- Parser limitation: inline brace-group short-circuit patterns like `cmd || { ... }` are not supported in `.jph` files yet. Use explicit conditionals like `if ! cmd; then ...; fi` instead.
- Entrypoint naming: `jaiph run` does not use file-name-based workflow lookup. Use `workflow default` as the entrypoint for runnable files.

## More Documentation

- Full docs: <https://jaiph.org/>
- Grammar: `docs/grammar.md`
- Agent bootstrap skill: `docs/jaiph-skill.md`
- Configuration: `docs/configuration.md`
- CLI: `docs/cli.md`
