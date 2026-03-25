---
title: Contributing
permalink: /contributing
redirect_from:
  - /contributing.md
---

# Contributing to Jaiph

Contributions are welcome. This page is about **how we work in the repo**: branch strategy, installing the CLI from a clone, coding and testing conventions, and the E2E shell harness. It does not teach the Jaiph language — start with [Getting Started](getting-started.md), then use [Grammar](grammar.md) and the rest of the guides for language and runtime behavior.

## Branching and pull requests

Development moves quickly and may include breaking changes. Two primary branches: **main** (stable) and **nightly** (latest).

- If you want to fix a bug, point your PR to the `main` branch, and check if the issue has already been addressed in `nightly`.
- If you are adding a new feature, submit your PR to `nightly` (and add or update tests in `e2e/tests`).
- For non-trivial bugs or features, open an issue with enough context to prioritize and discuss before or alongside a PR.
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

## Developing in the repository

For day-to-day work on the compiler and CLI you usually stay inside the clone: install dev dependencies once, then build and run tests from npm scripts.

**Prerequisites:** Node.js and npm (the installer also expects `git` and `bash`). End-to-end tests are written in bash and are run by `e2e/test_all.sh`.

**Typical commands** (from the repo root):

| Command | What it runs |
|---------|----------------|
| `npm install` | Installs TypeScript, Jest, and types (dev dependencies). |
| `npm run build` | Compiles TypeScript to `dist/` and copies runtime assets (stdlib, `src/runtime`, reporting static files). |
| `npm test` | `npm run build`, then the Node.js built-in test runner on `dist/test/*.test.js` and `dist/test/acceptance/*.acceptance.test.js`, then Jest on `test/fixtures-build.jest.test.js` (fixture build snapshot). |
| `npm run test:e2e` | Build plus `bash ./e2e/test_all.sh` (same as `test:acceptance:runtime`). |
| `npm run test:ci` | `npm test` followed by `npm run test:e2e` — useful before pushing when you want the full local picture. |

Run a single Node test file after a build with e.g. `node --test dist/test/parse-core.test.js`. The `dist/` paths mirror `test/*.test.ts` and `test/acceptance/*.acceptance.test.ts`.

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

Jaiph uses several test layers. Each layer catches a different class of bug. Use the narrowest layer that covers the behavior you're verifying.

| Layer | Location | What it catches | When to use |
|-------|----------|-----------------|-------------|
| **Unit tests** | `test/*.test.ts` | Bugs in pure functions (event parsing, param formatting, path resolution, config merging) | The function is self-contained, takes input and returns output, no I/O |
| **Compiler acceptance tests** | `test/acceptance/*.acceptance.test.ts` | Cross-module compiler behavior: validation errors, resolution, and other cases that need a temp project tree or subprocess | You need a deterministic error string, multi-file `build()`, or behavior that does not fit a tiny golden snippet |
| **Compiler golden tests** | `test/compiler-golden.test.ts` | Regressions in the transpiler and parser — many cases use **inline** expected `.sh` strings in the test file itself | You changed the emitter or parser and need to lock an exact emitted script or parse result (refresh the canonical workflow snippet with `scripts/dump-golden-output.js` when that embedded expectation changes) |
| **Fixture build snapshots** | `test/fixtures-build.jest.test.js`, `test/fixtures/*.jh`, `test/__snapshots__/fixtures-build.jest.test.js.snap` | The **whole** fixture set still builds and the generated `.sh` tree matches the Jest snapshot | You changed emission globally and need to catch drift across multiple real-world-ish `.jh` files — update the snapshot intentionally when output is meant to change |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the built workflow actually execute correctly end-to-end? | The behavior involves the CLI, bash runtime, process lifecycle, or file artifacts |

### Key principles

1. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
2. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
3. **Golden and snapshot tests are the compiler's safety net.** After transpiler changes, run `npm test`. Failures in `compiler-golden.test.ts` usually mean updating an explicit expected string in that file; for the main minimal workflow golden, run `npm run build && node scripts/dump-golden-output.js` and reconcile with the test source (see the comment above that case in `compiler-golden.test.ts`). If Jest reports a fixture snapshot mismatch, refresh it only when the new emitted `.sh` tree is correct, e.g. `npm run test:jest -- -u`.
4. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
5. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an E2E test. E2E tests are expensive to run and hard to debug — reserve them for integration-level behavior.

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
| `reporting-server.test.ts` | `src/reporting/` (`path-utils`, `summary-parser`, `artifact-path`, `run-registry`) | Safe paths, summary JSONL parsing, run registry polling, derived run status |

When adding a new source module or extending an existing one, follow this pattern: create or extend the corresponding `test/<module>.test.ts` file. This keeps unit tests discoverable — given a source file, the test file is predictable.

### Reference validation: ensure, run, and send RHS

After parse, the transpiler checks that `ensure` and `run` targets (and related refs, such as send right-hand sides) resolve to symbols of the right kind in the current or imported module. That logic lives in **`src/transpile/validate.ts`** (`validateReferences` and friends), with the shared **local vs `alias.name` resolution**, **wrong-kind** messages, and **`lookupKind`** extracted to **`src/transpile/validate-ref-resolution.ts`** (`validateRef` plus small message bundles per call site). If you change validation behavior, treat **exact `E_VALIDATE` strings** as part of the public contract unless you are deliberately shipping a breaking change — verify with `npm test`, compiler golden tests, and `npm run test:e2e`.

### Workflow module emission

After validation, each compiled workflow module becomes one bash script. Ownership is split so no single file grows into an unmaintainable monolith (see **Short files** under [Code philosophy](#code-philosophy) and Implementation Plan **0b** in `.jaiph/language_redesign_spec.md`).

| Source module | Responsibility |
|---------------|----------------|
| `emit-workflow.ts` | `emitWorkflow(...)` — shebang and stdlib bootstrap, metadata exports, env shims, inbox routes, orchestrates emission, then the main workflow `::impl` and entry dispatcher |
| `emit-rule.ts` | `emitRuleFunctions(...)` — iterates `ast.rules`, emits each rule's `::impl` and readonly wrapper |
| `emit-script.ts` | `emitScriptFunctions(...)` — iterates `ast.scripts`, emits bash for top-level **`script`** blocks |
| `emit-workflow-helpers.ts` | Metadata-to-env assignment helpers, scoped-metadata `push`/`pop`, `bashSingleQuotedSegment`, top-level env reference expansion |
| `emit-steps.ts` | `emitStep` and related helpers — individual Jaiph steps inside workflows and rules |

Moving logic between these modules is an internal refactor: **generated bash should stay byte-identical** unless you intend to change the transpiler contract. Use `npm test` (including `compiler-golden.test.ts` and fixture snapshots) and `npm run test:e2e` the same way as for any other emitter edit.

### Other test files in `test/`

Some files in `test/` don't follow the strict one-file-per-module layout. They exercise integration behavior, subprocesses, or acceptance-style scenarios:

| Test file | Kind | What it covers |
|-----------|------|----------------|
| `compiler-golden.test.ts` | Golden/regression | Large suite of parser/transpiler checks; includes inline expected bash for the canonical minimal workflow (see `scripts/dump-golden-output.js`), plus cases aligned with structured workflows/rules, `fail`, workflow `const` (including rejection of bare `ref args` without `run`), `wait`, brace-only `if`, send RHS, and script bodies |
| `fixtures-build.jest.test.js` | Snapshot | Builds everything under `test/fixtures/` and compares file list + contents to Jest snapshot |
| `sample-build.test.ts` | Integration | Cross-module build/transpile/run-tree behavior using real compiler and CLI components |
| `run-summary-jsonl.test.ts` | Integration | Runs the CLI on a small workflow and asserts structure and fields of `run_summary.jsonl` under `.jaiph/runs/` |
| `validate-managed-calls.test.ts` | Validation | Transpiler `E_VALIDATE` rules (e.g. disallowed command substitution calling Jaiph rules/workflows/scripts) |
| `non-tty-heartbeat.test.ts` | Acceptance | Non-TTY run: long step produces heartbeat line shape; uses built `dist/src/cli.js` |
| `stderr-handler.test.ts` | Unit/TTY | `registerTTYSubscriber` / stderr routing edge cases with a stubbed stdout |
| `signal-lifecycle.test.ts` | Acceptance | After SIGINT/SIGTERM, verifies `jaiph run` exits within a time bound and leaves no stale child processes |
| `tty-running-timer.test.ts` | Acceptance | In a TTY, verifies the "RUNNING workflow" line updates over time (requires Python 3 PTY harness) |
| `errors.test.ts` | Unit | Failure footer helpers: `readFailedStepOutput`, `failedStepArtifactPaths` (first failed `STEP_END` in `run_summary.jsonl` vs lexicographic “latest” artifacts in the run dir) |

Compiler acceptance tests that need multiple files or `spawnSync` live under `test/acceptance/` with the `*.acceptance.test.ts` suffix so `npm test` picks them up after build.

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

# Then — assert on run artifacts (matches e2e/tests/10_basic_workflows.sh)
e2e::expect_out_files "hello.jh" 1
e2e::expect_out "hello.jh" "default" "hello-jh"
```

When you need a **specific** sequence-prefixed filename (e.g. `000002-module__step.out`), use `e2e::expect_run_file` — see `e2e/tests/72_docker_run_artifacts.sh` and similar.

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
