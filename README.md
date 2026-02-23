# ![Jaiph](docs/logo.png)

**Open Source • Powerful • Friendly**

[jaiph.org](https://jaiph.org)

## What is Jaiph?

**Jaiph** is a scripting, declarative, and composable language for defining AI agent workflows.

It combines declarative workflow structure with Bash, then compiles to pure shell scripts. That keeps workflows portable and easy to understand while staying compatible with standard shell environments.

> [!WARNING]
> Jaiph is still in an early stage. Expect breaking changes.

- Docs: <https://github.com/jaiphlang/jaiph/tree/main/docs>
- Samples: <https://github.com/jaiphlang/jaiph/tree/main/samples>
- Contribute: <https://github.com/jaiphlang/jaiph/issues>

## Example

`main.jph`:

```jaiph
import "security.jph" as security
import "bootstrap_project.jph" as bootstrap

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
workflow main {
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

Transpiled output is standard Bash and includes Jaiph runtime helpers (`jaiph_stdlib.sh`), so workflows remain shell-native.

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

If that fails, check that `~/.local/bin` is in your `PATH` (default install directory).

### Running a workflow

```bash
jaiph run path/to/main.jph "feature request or task"
```

## Language Primitives

- `import "file.jph" as alias`  
  Imports rules/workflows from another Jaiph module under an alias. Imports are verified at compile time.

- `rule name { ... }`  
  Defines a reusable check/action that returns a shell exit code. Rules run in a read-only subshell and preserve stdout.

- `workflow name { ... }`  
  Defines an orchestration entrypoint made of ordered steps. Workflows can change system state.

- `ensure ref`  
  Executes a rule in a workflow or another rule.

- `run ref`  
  Executes another workflow in a workflow or another rule.

- `prompt "..."`  
  Sends prompt text to the configured agent command.

All Jaiph primitives can be combined with valid Bash code; they are fully interoperable with normal shell scripting.

## More Documentation

- Full docs: <https://github.com/jaiphlang/jaiph/tree/main/docs>
