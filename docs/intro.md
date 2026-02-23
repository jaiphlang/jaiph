# Intro

Jaiph is a small DSL for defining AI-assisted workflows that transpile to plain Bash.

It is designed for developer workflows where you want:

- versioned, reviewable source (`.jph`)
- deterministic shell execution (`.sh`)
- explicit module boundaries (`import ... as ...`)

## What a file can contain

- imports: `import "path.jph" as alias`
- rules: reusable checks or commands
- workflows: ordered orchestration of steps

## Core idea

- A **rule** compiles to a Bash function.
- A **workflow** compiles to a Bash function that calls rules/workflows.
- `ensure ...` calls a transpiled rule wrapper that runs through `jaiph__execute_readonly`.
- `run ...` calls a workflow.
- `prompt "..."` calls `jaiph__prompt`.

## Execution model

- One module transpiles to one shell file.
- Imports map to `source` statements.
- Rule and workflow symbols are namespaced from relative file paths.
- `ensure` references resolve at compile time and fail early on invalid refs.

## Why this shape

- Output is inspectable shell, not hidden runtime logic.
- Files stay composable through import aliases.
- Runtime behavior is deterministic and easy to debug.

For install and CLI basics, see `getting-started.md`.
For generated runtime helpers, see `stdlib.md`.
