---
title: Contributing
permalink: /contributing
redirect_from:
  - /contributing.md
---

# Contributing to Jaiph

Contributions are welcome.

## Branching and pull requests

Development moves quickly and may include breaking changes. Two primary branches: **main** (stable) and **nightly** (latest).

- If you want to fix a bug, point your PR to the `main` branch, and check if the issue has already been addressed in `nightly`.
- If you are adding a new feature, submit your PR to `nightly` (and add or update tests in `e2e/tests`).
- Create an issue with a thorough description of bugs or features before submitting code so changes can be prioritized and discussed.
- AI-assisted pull requests are welcome as long as they include comprehensive tests (including in `e2e/tests`).

## Installing from source

Use the local installer wrapper script in this repo:

```bash
./docs/install-from-local.sh
```

After install, verify:

```bash
jaiph --version
jaiph --help
```

The script installs from local source (including uncommitted changes) and places the CLI in `~/.local/bin` by default (or `JAIPH_BIN_DIR` if set).

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

#### Setup and lifecycle helpers

| Helper | Description |
|--------|-------------|
| `e2e::prepare_test_env "name"` | Set up a clean, isolated test environment: shared context, local install, temp test directory. Call once at the top of each test. |
| `e2e::cleanup` | Remove temp directories and stop any local server. Register with `trap e2e::cleanup EXIT`. |
| `e2e::section "label"` | Print a `== label ==` header for visual grouping of assertions. |

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
| `e2e::readonly_sandbox_available` | Return success if Linux read-only sandboxing prerequisites (`unshare`, passwordless `sudo`) are available. Use to guard platform-dependent tests with `e2e::skip`. |

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
| `e2e::assert_file_executable "path" "label"` | Assert that a file exists and is executable. |
| `e2e::pass "label"` | Print a `[PASS]` line. |
| `e2e::fail "label"` | Print a `[FAIL]` line to stderr and exit. |
| `e2e::skip "label"` | Print a `[SKIP]` line (for platform-dependent tests). |

### Why both tree output and artifact assertions?

Tree output assertions (`e2e::expect_stdout`) verify what the **user sees** in the terminal. Artifact assertions (`e2e::expect_out`, `e2e::expect_file`) verify what the **runtime persists** to disk. A bug could break one without affecting the other — for example, the CLI could display correct output while the runtime silently fails to write the `.out` file, or vice versa.
