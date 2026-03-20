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
- **mock prompt** — `mock prompt "<response>"` adds a mock response for the next prompt call. Mocks are consumed in order when the workflow runs. Use one per prompt in the workflow. When the workflow uses a **typed prompt** (`result = prompt "..." returns '{ ... }'`), the mock response must be valid JSON that satisfies the declared schema (e.g. one line of JSON with the required fields and correct types); otherwise the step fails with a parse or schema error. You can mock with a single line such as `mock prompt '{"type":"fix","risk":"low","summary":"Done"}'` so that `$result`, `$result_type`, `$result_risk`, etc. are set as expected.
- **mock prompt block** — `mock prompt { ... }` dispatches by prompt content. Use `if $1 contains "..." ; then` / `elif $1 contains "..." ; then` / optional `else` / `respond "..."` / `fi`. Each branch pairs a condition with a response. First matching branch wins; if no branch matches and there is no `else`, the test fails with a clear error.
- **mock workflow** — `mock workflow <alias>.<name> { ... }` replaces that workflow for this test with a shell body (e.g. `echo "ok"; exit 0`). Ref is `<alias>` or `<alias>.<workflow_name>`.
- **mock rule** — `mock rule <alias>.<name> { ... }` replaces that rule for this test with a shell body. Ref is `<alias>` or `<alias>.<rule_name>`.
- **mock function** — `mock function <name> { ... }` or `mock function <alias>.<name> { ... }` replaces that function for this test with a shell body.
- **Workflow run (capture)** — `name = <alias>.<workflow>` runs the workflow, captures combined stdout+stderr into `name`, and does not abort the test on non-zero exit so you can assert on the output. Optional: `name = <alias>.<workflow> "arg"` to pass one argument; `name = <alias>.<workflow> allow_failure` to run without failing the test on non-zero exit so you can assert on failure output. Prefer this over raw shell capture when you want to check failure output.
- **Workflow run (no capture)** — `<alias>.<workflow>` or `<alias>.<workflow> "arg"` runs the workflow without capturing output. The test fails if the workflow exits non-zero. Add `allow_failure` to allow non-zero exit (e.g. when you only care about side effects like a written file).
- **expectContain** — `expectContain <variable> "<substring>"` fails the test if the variable’s value does not contain the substring (error shows expected substring and output preview).
- **expectNotContain** — `expectNotContain <variable> "<substring>"` fails the test if the variable’s value contains the substring (useful to assert that certain output is absent).
- **expectEqual** — `expectEqual <variable> "<expected>"` fails the test if the variable’s value is not exactly equal to the expected string (error shows expected vs actual).

## Pass/fail reporting

- Each test block runs independently. A failing step (e.g. `expectContain`, or a workflow run that exits non-zero when capture is not used) marks that test as failed.
- Output: the runner prints `testing <file name>`, then for each test `  ▸ <description>` followed by either `  ✓` (and elapsed time) on success or `  ✗ <first error line>` (and elapsed time) on failure. Additional error lines are indented on stderr.
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

## E2E testing

The E2E test suite (`e2e/tests/*.sh`) exercises the full build-and-run pipeline from the outside: compile a workflow, run it, and assert on both the CLI tree output and the run artifact files (`.out`, `.err`) written to `.jaiph/runs/`.

### Test structure

Every E2E test follows a **Given / When / Then** pattern using helper functions from `e2e/lib/common.sh`. The helpers eliminate boilerplate so each test reads like a specification:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "my_test"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Feature under test"

# Given — create the workflow file inline
e2e::file "hello.jh" <<'EOF'
workflow default {
  echo "hello-jh"
}
EOF

# When — build and run
hello_out="$(e2e::run "hello.jh")"

# Then — assert on CLI tree output
e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
✓ PASS workflow default (<time>)
EOF

# Then — assert on run artifacts (by name or by glob)
e2e::expect_run_file "hello.jh" "000002-hello__default.out" "hello-jh"
# Or use the glob-based helper:
e2e::expect_out "hello.jh" "default" "hello-jh"
```

### Helper reference

All helpers are defined in `e2e/lib/common.sh`.

#### File and run helpers

| Helper | Description |
|--------|-------------|
| `e2e::file "name" <<'EOF' ... EOF` | Write a workflow file into the test directory from a heredoc. Creates parent directories as needed. |
| `e2e::run "file" [args...]` | Build and run a workflow file. Returns the CLI stdout for capture. |
| `e2e::expect_fail "file" [args...]` | Assert that running the workflow fails (non-zero exit). |
| `e2e::run_dir "file"` | Return the path of the single run directory for `file` under `.jaiph/runs/`. Fails if zero or more than one match. |
| `e2e::run_dir_at "base" "file"` | Same as `e2e::run_dir` but searches under a custom base directory. |
| `e2e::latest_run_dir_at "base" "file"` | Return the path of the most recent run directory for `file` under a custom base. Useful when a file may have been run multiple times. |
| `e2e::git_init` | Initialize a git repo in the test directory (portable across bash versions). |
| `e2e::git_current_branch` | Return the current branch name (defaults to `main` if detached). |

#### Tree output assertions

| Helper | Description |
|--------|-------------|
| `e2e::expect_stdout "$var" <<'EOF' ... EOF` | Assert that the captured CLI output matches the expected heredoc exactly (after ANSI stripping and time normalization). Use `<time>` as a placeholder for timing values. |

#### Run artifact assertions

After a workflow runs, its step outputs are written as files under `.jaiph/runs/`. Each artifact file is named with a zero-padded sequence prefix reflecting step execution order (e.g. `000001-module__step.out`, `000002-module__step.err`). The sequence counter is file-backed and shared across subshells, so steps inside looped `run` calls each receive a distinct prefix. This makes file names predictable and monotonically ordered, so tests can assert on exact file names without glob matching. These helpers verify the content of those files, catching bugs in the runtime's output-capture pipeline independently from what the CLI displays.

| Helper | Description |
|--------|-------------|
| `e2e::expect_out_files "file" N` | Assert that the run directory for `file` contains exactly `N` `.out` files. Use `0` for steps with no stdout (e.g. `touch`, `test`, redirected output). |
| `e2e::expect_out "file" "workflow" "expected"` | Assert that the `.out` file for a workflow step matches `expected` exactly. |
| `e2e::expect_rule_out "file" "rule" "expected"` | Assert that the `.out` file for a rule step matches `expected` exactly. Dot-separated rule names are normalized (e.g. `lib.ready` → `lib__ready`). |
| `e2e::expect_run_file "file" "name" "expected"` | Assert that a specific named file (e.g. `000002-module__step.out`) in the run directory for `file` matches `expected` exactly. Use when you need to assert on a file by its sequence-prefixed name. |
| `e2e::expect_run_file_at "base" "file" "name" "expected"` | Same as `e2e::expect_run_file` but searches under a custom base directory instead of `.jaiph/runs/`. Use for tests with custom `run.logs_dir` or `JAIPH_RUNS_DIR`. |
| `e2e::expect_run_file_count "file" N` | Assert that the run directory for `file` contains exactly `N` artifact files (`.out` + `.err` combined). |
| `e2e::expect_run_file_count_at "base" "file" N` | Same as `e2e::expect_run_file_count` but under a custom base directory. |
| `e2e::expect_file "glob" <<'EOF' ... EOF` | Assert that exactly one file matching `glob` exists under `.jaiph/runs/` and its content matches the heredoc. Useful for `.err` files or non-standard artifact names. |
| `e2e::expect_no_file "glob"` | Assert that no file matching `glob` exists under `.jaiph/runs/`. |

#### Low-level assertions

| Helper | Description |
|--------|-------------|
| `e2e::assert_contains "$actual" "$needle" "label"` | Assert that `actual` contains `needle`. |
| `e2e::assert_equals "$actual" "$expected" "label"` | Assert exact string equality. |
| `e2e::assert_file_exists "path" "label"` | Assert that a file exists at `path`. |
| `e2e::pass "label"` | Print a `[PASS]` line. |
| `e2e::fail "label"` | Print a `[FAIL]` line to stderr and exit. |
| `e2e::skip "label"` | Print a `[SKIP]` line (for platform-dependent tests). |

### Why both tree output and artifact assertions?

Tree output assertions (`e2e::expect_stdout`) verify what the **user sees** in the terminal. Artifact assertions (`e2e::expect_out`, `e2e::expect_file`) verify what the **runtime persists** to disk. A bug could break one without affecting the other — for example, the CLI could display correct output while the runtime silently fails to write the `.out` file, or vice versa.

## Limitations (v1)

- Mocks are inline only (e.g. `mock prompt "..."` or `mock prompt { ... }`). The legacy `.test.toml` format is not supported.
- Workflow invocation with capture stores combined stdout+stderr and strips internal event lines; the test does not fail on non-zero exit until you assert. Without capture, non-zero exit fails the test unless you use `allow_failure`.
- Test files must not define rules or workflows; they only import and run tests.
