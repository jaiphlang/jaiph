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
| `npm install` | Installs TypeScript and types (dev dependencies). |
| `npm run build` | Compiles TypeScript to `dist/` and copies runtime assets (`runtime/kernel`, reporting static files). |
| `npm run build:standalone` | `npm run build`, then copies `runtime/kernel` and `reporting/public` into `dist/` and runs **`bun build --compile`** on `src/cli.ts` → **`dist/jaiph`**. Requires [Bun](https://bun.sh) installed; ship the **`dist/`** directory (binary + sibling files) for a self-contained CLI layout. |
| `npm test` | `npm run build`, then the Node.js built-in test runner (with **`--enable-source-maps`**) on cross-cutting tests in `dist/test/*.test.js` and all colocated module tests under `dist/src/**/*.test.js` (including `*.acceptance.test.js`). |
| `npm run test:e2e` | Build plus `bash ./e2e/test_all.sh` (same as `test:acceptance:runtime`). |
| `npm run test:ci` | `npm test` followed by `npm run test:e2e` — useful before pushing when you want the full local picture. |

Run a single Node test file after a build with e.g. `node --test dist/src/parse/parse-core.test.js`. The `dist/` paths mirror the source layout under `src/`.

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
| **Module tests** | `src/**/*.test.ts` (colocated) | Bugs in pure functions (event parsing, param formatting, path resolution, config merging) | The function is self-contained, takes input and returns output, no I/O |
| **Compiler acceptance tests** | `src/transpile/*.acceptance.test.ts` (colocated) | Cross-module compiler behavior: validation errors, resolution, and other cases that need a temp project tree or subprocess | You need a deterministic error string, multi-file `buildScripts`, or behavior that does not fit a tiny golden snippet |
| **Compiler golden tests** | `src/transpile/compiler-golden.test.ts` (colocated) | Regressions in the parser and scripts-only extraction (`buildScriptFiles`) — expectations are inline snippets in the test file | You changed the parser, validator, or script emitter and need to lock an exact parse result or extracted script shape |
| **Cross-cutting tests** | `test/*.test.ts` | Process-level integration behavior: signal handling, TTY rendering, run summary structure, sample builds | The test spans multiple modules or requires subprocess/PTY harnesses |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the workflow actually execute correctly end-to-end? | The behavior involves the CLI launcher, Node runtime, process lifecycle, or file artifacts |

### Key principles

1. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
2. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
3. **Golden tests are the compiler's safety net.** After transpiler changes, run `npm test`. Failures in `src/transpile/compiler-golden.test.ts` usually mean updating an explicit expected string in that file; for the main minimal workflow golden, run `npm run build && node scripts/dump-golden-output.js` and reconcile with the test source (see the comment above that case in `compiler-golden.test.ts`).
4. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
5. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an E2E test. E2E tests are expensive to run and hard to debug — reserve them for integration-level behavior.

### Module test layout (colocated)

Module tests live next to the source files they validate, inside the same `src/` directory. Each test file is named `<module>.test.ts` alongside its source:

| Test file | Source module | What it covers |
|-----------|--------------|----------------|
| `src/parse/parse-core.test.ts` | `src/parse/core.ts` | Low-level parsing primitives: `stripQuotes`, `isRef`, `hasUnescapedClosingQuote`, `indexOfClosingDoubleQuote`, `colFromRaw`, `braceDepthDelta`, `fail` |
| `src/parse/parse-imports.test.ts` | `src/parse/imports.ts` | Import line parsing: valid/invalid paths, aliases, error cases |
| `src/parse/parse-env.test.ts` | `src/parse/env.ts` | Env declaration parsing: quoted values, multiline, unterminated strings, trailing content |
| `src/parse/parse-metadata.test.ts` | `src/parse/metadata.ts` | Config block parsing: value types, key validation, backend validation, error paths |
| `src/transpile/emit-steps.test.ts` | `src/transpile/emit-steps.ts` | Step emission helpers: param key extraction, shell local/export normalization, ref resolution, symbol transpilation |
| `src/transpile/compiler-golden.test.ts` | `src/transpiler.ts`, `src/transpile/*` | Golden/regression: inline expected bash for the canonical minimal workflow and structured scenarios |
| `src/transpile/validate-managed-calls.test.ts` | `src/transpile/validate.ts` | Transpiler `E_VALIDATE` rules (e.g. disallowed command substitution) |
| `src/transpile/compiler-edge.acceptance.test.ts` | `src/transpile/*` | Cross-module compiler acceptance: validation errors, resolution, multi-file builds |
| `src/cli/run/display.test.ts` | `src/cli/run/display.ts` | CLI display formatting: `colorize` (ANSI/NO_COLOR), `formatCompletedLine`, `formatStartLine` |
| `src/cli/run/resolve-env.test.ts` | `src/cli/run/env.ts` | Runtime environment resolution: workspace, config defaults, env precedence, locked keys, transient cleanup |
| `src/cli/run/events.test.ts` | `src/cli/run/events.ts` | Event parsing: `parseLogEvent`, `parseStepEvent` for `__JAIPH_EVENT__` JSON lines |
| `src/cli/run/hooks.test.ts` | `src/cli/run/hooks.ts` | Hook lifecycle: `globalHooksPath`, `projectHooksPath`, `parseHookConfig`, `loadMergedHooks`, `runHooksForEvent` |
| `src/cli/run/non-tty-heartbeat.test.ts` | `src/cli/run/*` | Non-TTY run: long step produces heartbeat line shape |
| `src/cli/run/stderr-handler.test.ts` | `src/cli/run/stderr-handler.ts` | `registerTTYSubscriber` / stderr routing edge cases |
| `src/cli/shared/jaiph-source-map.test.ts` | `src/cli/shared/jaiph-source-map.ts` | Load **`.jaiph.map`**, bash-line → **`.jh`** resolution, stderr diagnostic line rewriting |
| `src/cli/shared/errors.test.ts` | `src/cli/shared/errors.ts` | Error summarization: `summarizeError`, `resolveFailureDetails`, `hasFatalRuntimeStderr`, run metadata extraction |
| `src/cli/commands/format-params-display.test.ts` | `src/cli/commands/format-params.ts` | Parameter display formatting: `formatParamsForDisplay`, `formatNamedParamsForDisplay`, `normalizeParamValue` |
| `src/runtime/docker.test.ts` | `src/runtime/docker.ts` | Docker integration helpers: mount parsing/validation, config resolution, `buildDockerArgs` |
| `src/runtime/kernel/prompt.test.ts` | `src/runtime/kernel/prompt.ts` | JS kernel prompt execution: config resolution, backend arg building, mock dispatch, end-to-end prompt flow |
| `src/runtime/kernel/stream-parser.test.ts` | `src/runtime/kernel/stream-parser.ts` | Stream JSON parser: reasoning/final extraction, section headers, fallback handling |
| `src/runtime/kernel/schema.test.ts` | `src/runtime/kernel/schema.ts` | Typed prompt schema validation: JSON extraction strategies, field presence/type checks, eval-line generation |
| `src/runtime/kernel/mock.test.ts` | `src/runtime/kernel/mock.ts` | Test-mode mock helpers: sequential mock responses, dispatch script invocation |
| `src/runtime/kernel/seq-alloc.test.ts` | `src/runtime/kernel/seq-alloc.ts` | Atomic step-sequence allocator: monotonic unique values, resume from existing `.seq` file |
| `src/runtime/kernel/emit.test.ts` | `src/runtime/kernel/emit.ts` | **`live`** stderr `__JAIPH_EVENT__` JSON and **`summary-line`** stdin → `run_summary.jsonl` append (fd routing, JSON shape) |
| `src/reporting/reporting-server.test.ts` | `src/reporting/*` | Safe paths, summary JSONL parsing, run registry polling, derived run status |

**Kernel — `emit.ts`:** **`src/runtime/kernel/emit.ts`** handles **`live`** progress JSON to stderr and **`summary-line`** appends to `run_summary.jsonl`. **`appendRunSummaryLine`** uses shared **`mkdir`-style locking** from **`fs-lock.ts`**.

**Kernel — `seq-alloc.ts`:** **`src/runtime/kernel/seq-alloc.ts`** is the single owner of step-sequence allocation. It reads, increments, and writes the `.seq` file under the run directory atomically using `mkdir`-style locking from **`fs-lock.ts`** (same mechanism as `emit.ts` and `inbox.ts`). Colocated test: `seq-alloc.test.ts`.

**Kernel — `inbox.ts`:** **`src/runtime/kernel/inbox.ts`** implements file-backed **init**, **send**, **register-route**, and **drain** under the run directory’s `inbox/` subdirectory, including **`INBOX_*` `run_summary.jsonl`** lines and parallel **`inbox/.seq.lock`** behavior. There is no colocated `inbox.test.ts` yet; behavior is covered by **E2E** (e.g. inbox dispatch and run-summary contract tests).

**Kernel — `run-step-exec.ts`:** Managed script subprocess execution lives in **`src/runtime/kernel/run-step-exec.ts`**. There is no colocated `run-step-exec.test.ts` yet; behavior is covered by the **E2E** suite and runtime integration. Prefer adding focused unit tests if you extract pure helpers from the spawn/capture path.

**Kernel — `node-test-runner.ts`:** **`src/runtime/kernel/node-test-runner.ts`** executes `*.test.jh` test blocks using `NodeWorkflowRuntime` with mock support (prompt queues, content-based dispatch, workflow/rule/script body replacements) and assertion evaluation. Pure Node harness — no Bash test transpilation.

When adding a new source module or extending an existing one, create or extend the corresponding `*.test.ts` file in the same directory. This keeps tests discoverable — given a source file, the test file is always a sibling.

### Reference validation: ensure, run, and send RHS

After parse, the transpiler checks that `ensure` and `run` targets (and related refs, such as send right-hand sides) resolve to symbols of the right kind in the current or imported module. That logic lives in **`src/transpile/validate.ts`** (`validateReferences` and friends), with the shared **local vs `alias.name` resolution**, **wrong-kind** messages, and **`lookupKind`** extracted to **`src/transpile/validate-ref-resolution.ts`** (`validateRef` plus small message bundles per call site). If you change validation behavior, treat **exact `E_VALIDATE` strings** as part of the public contract unless you are deliberately shipping a breaking change — verify with `npm test`, compiler golden tests, and `npm run test:e2e`.

### Workflow module emission (golden tests only)

The transpiler can still produce a full bash module string per compiled workflow module — but this path is **not used for production execution**. All `jaiph run`, `jaiph test`, and Docker runs go through the Node workflow runtime (`NodeWorkflowRuntime`), which interprets the AST directly. The bash emission exists for **compiler golden tests** that lock the emitter's output against regressions.

`buildScripts()` — the production preparation path — persists **only** extracted per-step `script` files under `scripts/`. No workflow-level `.sh` is written for any execution path.

The emission modules remain in the codebase for the golden test contract:

| Source module | Responsibility |
|---------------|----------------|
| `emit-workflow.ts` | `emitWorkflow(...)` → `EmittedModule` (`{ module: string; scripts: Array<{ name: string; content: string }> }`) — function definitions (no stdlib preamble or entrypoint), `JAIPH_SCRIPTS` export, metadata exports, env shims, inbox routes, orchestrates emission, then the main workflow `::impl` and entry dispatcher |
| `emit-rule.ts` | `emitRuleFunctions(...)` — iterates `ast.rules`, emits each rule's `::impl` and readonly wrapper |
| `emit-script.ts` | `emitScriptFunctions(...)` — iterates `ast.scripts`, emits wrapper functions that invoke scripts via `$JAIPH_SCRIPTS/<name>`. `buildScriptFiles(...)` produces standalone executable file content for each script (shebang + body) |
| `emit-workflow-helpers.ts` | Metadata-to-env assignment helpers, scoped-metadata `push`/`pop`, `bashSingleQuotedSegment`, top-level env reference expansion |
| `emit-steps.ts` | `emitStep` and related helpers — individual Jaiph steps inside workflows and rules |

Moving logic between these modules is an internal refactor: **generated bash should stay byte-identical** unless you intend to change the transpiler contract. Use `npm test` (including `compiler-golden.test.ts`) and `npm run test:e2e` the same way as for any other emitter edit.

### Cross-cutting tests in `test/`

Tests that span multiple modules, require subprocess/PTY harnesses, or exercise process-level behavior remain in `test/`. These do not belong to a single module:

| Test file | Kind | What it covers |
|-----------|------|----------------|
| `sample-build.test.ts` | Integration | Cross-module build/transpile/run-tree behavior using real compiler and CLI components |
| `run-summary-jsonl.test.ts` | Integration | Runs the CLI on a small workflow and asserts structure and fields of `run_summary.jsonl` under `.jaiph/runs/` |
| `signal-lifecycle.test.ts` | Acceptance | After SIGINT/SIGTERM, verifies `jaiph run` exits within a time bound and leaves no stale child processes |
| `tty-running-timer.test.ts` | Acceptance | In a TTY, verifies the “RUNNING workflow” line updates over time (requires Python 3 PTY harness) |

Shared test data (`test/fixtures/`, `test/expected/`) also remains in `test/`.

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
workflow default() {
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

After a workflow runs, its step outputs are written as files under `.jaiph/runs/`. Each artifact file is named with a zero-padded sequence prefix reflecting step execution order (e.g. `000001-module__step.out`, `000002-module__step.err`). The sequence counter is file-backed (`.seq` under the run directory) and allocated atomically by the JS kernel (`kernel/seq-alloc.js`) so concurrent async branches (`run async`) each receive a unique monotonic prefix — no two steps share a `seq` within the same run. This makes file names predictable and ordered, so tests can assert on exact file names without glob matching. These helpers verify the content of those files, catching bugs in the runtime's output-capture pipeline independently from what the CLI displays.

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

### Default contract: full equality

Every E2E assertion should compare the **full** expected text — CLI stdout via heredoc, artifact file contents, JSONL lines — not substrings. Use `e2e::expect_stdout`, `e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`, or `e2e::assert_equals` / `e2e::assert_output_equals`.

`e2e::assert_contains` (substring check) is the **exception**, not the default. Every use must include an inline comment explaining why full equality is not feasible. Allowed reasons:

- **Nondeterministic output** — prompt transcripts with real agent backends, timestamps not covered by `<time>` normalization.
- **Unbounded or variable-length logs** — `run_summary.jsonl` with platform-dependent event counts, live step output where line count varies.
- **Platform-dependent text** — OS-specific error messages, paths that differ across CI.

For the full E2E philosophy, artifact layout, and normalization details, see [ARCHITECTURE.md — E2E test philosophy](../ARCHITECTURE.md#e2e-test-philosophy-and-artifact-layout).

### Migration checklist: remaining `assert_contains` usages

The following tests still use `e2e::assert_contains`. Each entry is categorized as **converted** (migrated to full equality), **convertible** (can be migrated), or **justified exception** (substring check is appropriate with inline comment).

#### Converted to full equality

These were migrated from `assert_contains` to `assert_equals` / full-equality helpers:

| File | What was converted | Notes |
|------|--------------------|-------|
| `30_filesystem_side_effects.sh` | `workflow_wrote.txt` side-effect file | 1 call → `assert_equals` |
| `74_live_step_output.sh` | Final `.out`/`.err` artifact content | 6 calls → 2 `assert_equals` with full multi-line content |
| `91_inbox_dispatch.sh` | Side-effect files (`received.txt`, `consumer_*.txt`, `args.txt`, inbox file) | 9 calls → `assert_equals` (args.txt consolidated to 1 multi-line check) |
| `92_log_logerr.sh` | `.out`/`.err` artifacts and script stdout | 3 calls → `assert_equals` |
| `93_inbox_stress.sh` | Nested processing result file | 1 call → `assert_equals` |
| `97_step_output_contract.sh` | Rule `.out`, workflow `.out`, function `.out` return value artifacts | 5 calls → `assert_equals` |
| `98_ensure_recover_value.sh` | Capture variable `.out` and rule `.out` artifact | 2 calls → `assert_equals` |
| `101_script_isolation.sh` | Shared library script `.out` | 1 call → `assert_equals` |

#### Convertible to full equality

These remain as `assert_contains` but could be migrated once exact artifact content is verified:

| File | Lines | What's checked | Notes |
|------|-------|---------------|-------|
| `94_parallel_shell_steps.sh` | 36–37, 104–105 | Side-effect files and `.out` content | 4 calls; test is skipped (unsupported semantics) |

#### Justified exceptions (substring check appropriate, with inline comments)

| File | Lines | Reason |
|------|-------|--------|
| `70_run_artifacts.sh` | 53–59, 95–98 | CLI failure stderr (variable paths), `run_summary.jsonl` (variable-length), prompt transcripts (nondeterministic agent format) |
| `92_log_logerr.sh` | 61–64 | `run_summary.jsonl` — variable-length, timestamps |
| `72_docker_run_artifacts.sh` | 48 | `run_summary.jsonl` inside Docker — variable event count |
| `78_lang_redesign_constructs.sh` | 25–294 | CLI stdout with progress tree formatting — timing, indentation varies |
| `50_cli_and_parse_guards.sh` | 78–221 | Parser/validator error messages — checking diagnostic keywords |
| `91_inbox_dispatch.sh` | 126, 204–207 | Compiler error stderr (variable paths), CLI progress tree with timing |
| `80_cli_behavior.sh` | 18, 34–55 | CLI version banner, error help text — format may evolve |
| `104_run_async.sh` | 47, 78–79, 129 | Async progress tree, failure messages — timing-dependent |
| `81_tty_progress_tree.sh` | 95 | TTY live render — inherently nondeterministic |
| `20_rule_and_prompt.sh` | 86, 120, 165–167, 192, 265 | Prompt transcripts (agent format), rule failure stderr |
| `71_loop_run_artifacts.sh` | 51–53 | Prompt transcripts — agent output format |
| `61_ensure_recover.sh` | 100, 156, 196 | Side-effect file, CLI failure stderr, prompt output |
| `79_workflow_fail_keyword.sh` | 26 | CLI stderr fail message |
| `89_reporting_server.sh` | 59, 91, 94 | Reporting API JSON and raw log — format may include extra fields |
| `93_ensure_recover_payload.sh` | 74–80 | CLI progress tree with timing |
| `97_step_output_contract.sh` | 40–41, 48, 192, 217–218, 225 | Aggregated workflow `.out`/`.err` with multiple step outputs; prompt capture (nondeterministic) |
| `97_async_managed_failure.sh` | 44 | Async failure message in progress output |
| `98_ensure_recover_value.sh` | 80 | Recover `$1` merged stdout+stderr — variable aggregation format |
| `99_managed_call_semantics.sh` | 50 | Script `.out` aggregates multiple echo lines; capture semantics vary |
| `100_ensure_recover_invalid.sh` | 38–97 | Parser error diagnostics — checking keywords |
| `101_ensure_recover_output_contract.sh` | 44–45, 85–87, 124–127, 179–180 | Recover payload is merged stdout+stderr; exact aggregation format varies |
| `101_script_isolation.sh` | 125 | Compiler error stderr includes file paths and line numbers |
| `102_engineer_recover_contract.sh` | 57–58 | Recover payload contains rule stdout+stderr — variable format |
| `103_run_dir_source_name.sh` | 29, 35 | Run dir path — contains dynamic date component |
| `00_install_and_init.sh` | 18 | CLI help output — format may evolve |
| `05_jaiph_use_pinned_version.sh` | 21, 29 | Version output — dynamic version string |
| `91_top_level_local.sh` | 44–45 | Multi-line const value — checking partial lines of large value |

### Why both tree output and artifact assertions?

Tree output assertions (`e2e::expect_stdout`) verify what the **user sees** in the terminal. Artifact assertions (`e2e::expect_out`, `e2e::expect_file`) verify what the **runtime persists** to disk. A bug could break one without affecting the other — for example, the CLI could display correct output while the runtime silently fails to write the `.out` file, or vice versa.
