---
title: Testing
permalink: /testing
redirect_from:
  - /testing.md
---

# Testing Jaiph Workflows

You can test Jaiph workflows by writing test scripts that run workflows under controlled conditions and assert on their output or side effects. Tests live in dedicated files, use the same import system as workflows, and support mocking prompts and dependencies so runs are deterministic and fast.

**Concepts**

- **Test files** — Files named `*.test.jh` (or `*.test.jph`) contain only imports and test blocks. They are discovered and run by `jaiph test`.
- **Test blocks** — Each `test "description" { ... }` block is one test case: a sequence of steps (mocks, workflow runs, assertions).
- **Mocks** — You can mock prompt responses, workflows, rules, and functions so the workflow under test sees fixed or scripted behavior.
- **Assertions** — Capture workflow stdout+stderr into a variable, then use `expectContain`, `expectNotContain`, or `expectEqual` to verify the output.

## File naming

- Name test files with the `.test.jh` (or `.test.jph`) suffix, for example `workflow.test.jh`.
- A test file must contain at least one test block. Only imports and test blocks are allowed; do not define rules or workflows in test files.
- `jaiph test` discovers all `*.test.jh` and `*.test.jph` files under the given path (recursively). When no path is given, the workspace root is inferred from the current directory and tests are discovered from there.

## Running tests

```bash
# Run all *.test.jh / *.test.jph files in the workspace (recursive)
jaiph test

# Run tests in a directory (recursive)
jaiph test ./e2e

# Run a single test file
jaiph test ./e2e/workflow_greeting.test.jh
```

## Test blocks

Inside a `*.test.jh` file you can use:

1. **Imports** — Same as in workflow files: `import "<path>" as <alias>`.
2. **Test blocks** — `test "description" { ... }` with one or more steps. The workflow reference in each run step must be `<alias>.<workflow>` (two parts; the alias from an import and the workflow name from that module).

Example:

```jaiph
import "workflow_greeting.jh" as w

test "runs happy path and output contains expected mock" {
  mock prompt "greeting-mock"
  response = w.default
  expectContain response "greeting-mock"
  expectContain response "done"
}
```

### Steps inside a test block

- **Shell** — Any bash statement (e.g. `echo "given"`, `# comment`). Use for setup, reading files, or custom capture when needed.
- **mock prompt** — `mock prompt "<response>"` (or `mock prompt '<response>'`) adds a mock response for the next prompt call. Mocks are consumed in order when the workflow runs. Use one per prompt in the workflow. When the workflow uses a **typed prompt** (`result = prompt "..." returns '{ ... }'`), the mock response must be valid JSON that satisfies the declared schema (e.g. one line of JSON with the required fields and correct types); otherwise the step fails with a parse or schema error. You can mock with a single line such as `mock prompt '{"type":"fix","risk":"low","summary":"Done"}'` so that `$result`, `$result_type`, `$result_risk`, etc. are set as expected.
- **mock prompt block** — `mock prompt { ... }` dispatches by prompt content. Use `if $1 contains "..." ; then` / `elif $1 contains "..." ; then` / optional `else` / `respond "..."` / `fi`. Each branch pairs a condition with a response. First matching branch wins; if no branch matches and there is no `else`, the test fails with a clear error.
- **mock workflow** — `mock workflow <alias>.<name> { ... }` replaces that workflow for this test with a shell body (e.g. `echo "ok"; exit 0`). Ref is `<alias>` or `<alias>.<workflow_name>`.
- **mock rule** — `mock rule <alias>.<name> { ... }` replaces that rule for this test with a shell body. Ref is `<alias>` or `<alias>.<rule_name>`.
- **mock function** — `mock function <name> { ... }` or `mock function <alias>.<name> { ... }` replaces that function for this test with a shell body.
- **Workflow run (capture)** — `name = <alias>.<workflow>` runs the workflow and captures combined stdout+stderr into `name`. The test fails if the workflow exits non-zero. Variants: `name = <alias>.<workflow> "arg"` to pass one argument; `name = <alias>.<workflow> allow_failure` to suppress the non-zero exit check so you can assert on failure output; `name = <alias>.<workflow> "arg" allow_failure` to combine both.
- **Workflow run (no capture)** — `<alias>.<workflow>` or `<alias>.<workflow> "arg"` runs the workflow without capturing output. The test fails if the workflow exits non-zero. Add `allow_failure` to suppress the exit check (e.g. `<alias>.<workflow> allow_failure` or `<alias>.<workflow> "arg" allow_failure`).
- **expectContain** — `expectContain <variable> "<substring>"` fails the test if the variable’s value does not contain the substring (error shows expected substring and output preview).
- **expectNotContain** — `expectNotContain <variable> "<substring>"` fails the test if the variable’s value contains the substring (useful to assert that certain output is absent).
- **expectEqual** — `expectEqual <variable> "<expected>"` fails the test if the variable’s value is not exactly equal to the expected string (error shows expected vs actual).

## Pass/fail reporting

- Each test block runs independently. A failing step (e.g. `expectContain`, or a workflow run that exits non-zero without `allow_failure`) marks that test as failed.
- Output: the runner prints `testing <file name>`, then for each test `  ▸ <description>` followed by either `  ✓ <kind> <name> (<elapsed>)` on success or `  ✗ <kind> <name> (<elapsed>)` with the first error line on failure. Additional error lines are indented on stderr.
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

## Stress and soak testing

For concurrency-sensitive features (e.g. parallel inbox dispatch), Jaiph
includes stress-style E2E tests that go beyond single-run assertions:

- **High-volume and fan-out scenarios** exercise lock contention and
  dispatch correctness under concurrent writes.
- **Soak runs** repeat the same scenario across multiple iterations to
  surface heisenbugs that only manifest under repeated execution.
- **Order-insensitive assertions** validate counts, uniqueness, and
  completeness without depending on execution order — important when
  parallel dispatch makes ordering non-deterministic.

See `e2e/tests/93_inbox_stress.sh` for a concrete example covering all
of these patterns. For parallel shell step scenarios (background jobs,
`wait` semantics, concurrent stdout capture, and artifact integrity),
see `e2e/tests/94_parallel_shell_steps.sh`.

## E2E testing

E2E testing guidance was moved to [Contributing](contributing.md#e2e-testing).

## Limitations (v1)

- Mocks are inline only (e.g. `mock prompt "..."` or `mock prompt { ... }`). The legacy `.test.toml` format is not supported.
- Workflow invocation with capture stores combined stdout+stderr and strips internal event lines. Both capture and no-capture forms fail the test on non-zero exit unless `allow_failure` is used.
- Test files must not define rules or workflows; they only import and run tests.
