# Testing Jaiph Workflows

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Jaiph supports native test scripts via the `*.test.jh` convention and first-class `test "description" { ... }` blocks.

## File naming

- Name test files with the `.test.jh` (or `.test.jph`) suffix, for example `workflow.test.jh`.
- `jaiph test` discovers and runs all `*.test.jh` and `*.test.jph` files under the given path (or workspace root when no path is given).

## Running tests

```bash
# Run all *.test.jh files in the workspace
jaiph test

# Run tests in a directory
jaiph test ./e2e

# Run a single test file
jaiph test ./e2e/workflow.test.jh
```

## Test blocks

Inside a `*.test.jh` file you can use:

1. **Imports** — same as in workflow files: `import "<path>" as <alias>`.
2. **Test blocks** — `test "description" { ... }` with one or more steps.

Example:

```jaiph
import "workflow" as w

test "runs happy path and prints pass tree" {
  response = w.default
  expectContain response "PASS"
}
```

### Steps inside a test block

- **Shell** — any bash statement (e.g. `echo "given"`, `# comment`).
- **mock prompt** — `mock prompt "<response>"` adds a mock response for the next prompt call. Mocks are consumed in order when the workflow runs. Use one per prompt in the workflow.
- **mock prompt block** — `mock prompt { ... }` dispatches by prompt content. Use `if $1 contains "..." ; then` / `elif $1 contains "..." ; then` / optional `else` / `respond "..."` / `fi`. First matching branch wins; if no branch matches and there is no `else`, the test fails with a clear error.
- **Workflow capture** — `name = <alias>.<workflow>` runs the workflow, captures stdout+stderr into `name`, and does not abort on non-zero exit. You can then assert on the output. Use `name = <alias>.<workflow> "arg"` to pass one argument, or `name = <alias>.<workflow> allow_failure` to run without failing the test on non-zero exit (so you can assert on failure output).
- **expectContain** — `expectContain <variable> "<substring>"` fails the test with a readable error if the variable's value does not contain the substring.

## Pass/fail reporting

- Each test block runs independently. A failing step (e.g. `expectContain`) marks that test as FAIL and the run as failed.
- Output is per-test: `PASS "description"` or `FAIL "description"` with optional error details on stderr.
- Exit code is 0 if all tests pass, non-zero otherwise.

## Given/When/Then style

You can structure tests with comments and capture/assert steps:

```jaiph
import "app" as app

test "default workflow prints greeting" {
  # Given
  mock prompt "hello"

  # When
  out = app.default

  # Then
  expectContain out "hello"
}
```

## Limitations (v1)

- Mocks are **inline only** (e.g. `mock prompt "..."` or `mock prompt { ... }`). The legacy `.test.toml` format is not supported.
- Workflow invocation inside tests captures combined stdout+stderr and does not abort the process on failure; you assert explicitly with `expectContain`.
- Test files must not define rules or workflows; they only import and run tests.
