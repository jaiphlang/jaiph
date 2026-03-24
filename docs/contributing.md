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

## Code philosophy

Jaiph's codebase is maintained by both humans and AI agents. Code should be easy to read, navigate, and modify for both — which means the same thing: straightforward, flat, and explicit.

### Principles

1. **Plain functions with explicit arguments.** Avoid classes and abstraction-heavy generics. If a file already uses generics, follow the local style and keep additions minimal. No visitor patterns or dependency injection. A function takes data in, returns data out, or pushes to an array. If you need shared context, pass a plain object — not a class instance.
2. **Flat control flow.** If/else chains and switch statements, not multi-layer abstractions. An AI (or human) should be able to read a function top-to-bottom and understand what it does without jumping to 3 other files.
3. **Short files.** No source file should exceed ~400 lines. If a file grows past that, split it into sibling files in the same directory — not a deeper module tree.
4. **No duplication across files.** If the same logic exists in two places, extract it into one plain function and call it from both. Duplication means bug fixes get applied in one place and missed in the other.
5. **Minimal touch surface for new features.** Adding a new step type, CLI command, or runtime feature should require changes in at most 3 files (type definition, parser/handler, emitter/consumer). If it requires more, the architecture needs refactoring first.
6. **No speculative abstractions.** Don't add indirection, registries, or plugin systems to "support future extensibility." Add the simplest thing that works now. Refactor when the concrete need appears.
7. **Red flag: >100 lines of custom code.** Before writing a large chunk, check if the library or existing codebase already provides it. If not, explain why the new code is necessary.

## Testing philosophy

Jaiph has four test layers. Each layer catches a different class of bug. Use the narrowest layer that covers the behavior you're verifying.

| Layer | Location | What it catches | When to use |
|-------|----------|-----------------|-------------|
| **Unit tests** | `test/*.test.ts` | Bugs in pure functions (event parsing, param formatting, path resolution, config merging) | The function is self-contained, takes input and returns output, no I/O |
| **Compiler acceptance tests** | `test/acceptance/*.test.ts` | Parser/transpiler edge cases — malformed input, error messages, boundary conditions | You need to assert on a specific error code/message or a parser branch that doesn't map to a full workflow |
| **Golden output tests** | `test/compiler-golden.test.ts`, `test/fixtures/`, `test/expected/` | Compiler regressions — verifies that a `.jh` file produces an exact `.sh` output | You changed the emitter and need to prove the bash output is identical (or intentionally different) |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the built workflow actually execute correctly end-to-end? | The behavior involves the CLI, bash runtime, process lifecycle, or file artifacts |

### Key principles

1. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
2. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
3. **Golden outputs are the compiler's safety net.** After any transpiler change, run `npm test` — golden tests will catch unintended output differences. Use `scripts/dump-golden-output.js` to regenerate expected output when the change is intentional.
4. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
5. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an e2e test. E2e tests are expensive to run and hard to debug — reserve them for integration-level behavior.

### Unit test file layout

Unit tests in `test/*.test.ts` are organized by source module. Each test file maps to a specific source file or functional area:

| Test file | Source module | What it covers |
|-----------|--------------|----------------|
| `parse-core.test.ts` | `src/parse/core.ts` | Low-level parsing primitives: `stripQuotes`, `isRef`, `hasUnescapedClosingQuote`, `indexOfClosingDoubleQuote`, `colFromRaw`, `braceDepthDelta`, `fail` |
| `parse-imports.test.ts` | `src/parse/imports.ts` | Import line parsing: valid/invalid paths, aliases, error cases |
| `parse-env.test.ts` | `src/parse/env.ts` | Env declaration parsing: quoted values, multiline, unterminated strings, trailing content |
| `parse-metadata.test.ts` | `src/parse/metadata.ts` | Config block parsing: value types, key validation, backend validation, error paths |
| `emit-steps.test.ts` | `src/transpile/emit-steps.ts` | Step emission helpers: param key extraction, shell local/export normalization, ref resolution, symbol transpilation |
| `display.test.ts` | `src/cli/run/display.ts` | CLI display formatting: `colorize` (ANSI/NO_COLOR), `formatCompletedLine`, `formatStartLine` |
| `resolve-env.test.ts` | `src/cli/run/env.ts` | Runtime environment resolution: workspace, config defaults, env precedence, locked keys, transient cleanup |
| `errors.test.ts` | `src/cli/shared/errors.ts` | Error summarization: `summarizeError`, `resolveFailureDetails`, `hasFatalRuntimeStderr`, run metadata extraction |
| `events.test.ts` | `src/cli/run/events.ts` | Event parsing: `parseLogEvent`, `parseStepEvent` for `__JAIPH_EVENT__` JSON lines |
| `format-params-display.test.ts` | `src/cli/commands/format-params.ts` | Parameter display formatting: `formatParamsForDisplay`, `formatNamedParamsForDisplay`, `normalizeParamValue` |
| `docker.test.ts` | `src/runtime/docker.ts` | Docker integration helpers: mount parsing/validation, config resolution, `buildDockerArgs` |
| `hooks.test.ts` | `src/cli/run/hooks.ts` | Hook lifecycle: `globalHooksPath`, `projectHooksPath`, `parseHookConfig`, `loadMergedHooks`, `runHooksForEvent` |

When adding a new source module or extending an existing one, follow this pattern: create or extend the corresponding `test/<module>.test.ts` file. This keeps unit tests discoverable — given a source file, the test file is predictable.

### Other test files in `test/`

A few test files in `test/` don't follow the unit-test-per-module pattern. They exercise broader behavior or acceptance criteria:

| Test file | Kind | What it covers |
|-----------|------|----------------|
| `compiler-golden.test.ts` | Golden/regression | Runs the golden output tests — compares transpiler output for `test/fixtures/*.jh` against `test/expected/*.sh` |
| `sample-build.test.ts` | Integration | Cross-module build/transpile/run-tree behavior using real compiler and CLI components |
| `signal-lifecycle.test.ts` | Acceptance | After SIGINT/SIGTERM, verifies `jaiph run` exits within a time bound and leaves no stale child processes |
| `tty-running-timer.test.ts` | Acceptance | In a TTY, verifies the "RUNNING workflow" line updates over time (requires Python 3 PTY harness) |

## E2E testing

The E2E test suite (`e2e/tests/*.sh`) exercises the full build-and-run pipeline from the outside: compile a workflow, run it, and assert on both the CLI tree output and the run artifact files (`.out`, `.err`) written to `.jaiph/runs/`.

Some scripts are **contract** tests: they validate persisted machine-readable output (for example `e2e/tests/88_run_summary_event_contract.sh` and `run_summary.jsonl`) in addition to or instead of golden CLI trees.

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
