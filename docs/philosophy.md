# Philosophy

Jaiph optimizes for operational clarity over language cleverness.

## Principles

1. **Shell-first runtime**
   - Generated code should be readable and executable with normal shell tooling.
2. **Explicit orchestration**
   - Workflows are explicit step lists, not implicit planners.
3. **Small syntax surface**
   - Prefer a few predictable forms over many shortcuts.
4. **Composable modules**
   - Imports with aliases prevent naming collisions.
5. **Safety by default for rule checks**
   - `ensure` goes through rule wrappers that call `jaiph__execute_readonly`.

## Non-goals (current)

- Full general-purpose programming language semantics
- Hidden background scheduler/runtime
- Rich type system
- Automatic inference of missing workflow steps
