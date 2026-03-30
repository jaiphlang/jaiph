---
title: Contributing
permalink: /contributing
redirect_from:
  - /contributing.md
---

# Contributing to Jaiph

Open-source projects depend on clear repo conventions: how to build, test, and propose changes. **This page is that map for Jaiph** — branches, installing from a clone, TypeScript layout and philosophy, the layered test strategy, and the bash E2E harness. It does **not** teach the language or runtime semantics; for that, use [Getting Started](getting-started.md), [Grammar](grammar.md), and [Architecture](../ARCHITECTURE.md) for execution flow and contracts.

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
| `npm run build` | Runs `tsc`, then copies **`src/runtime`** → **`dist/src/runtime`** and **`src/reporting/public`** → **`dist/src/reporting/public`** (kernel JS and reporting assets for the compiled CLI). |
| `npm run build:standalone` | `npm run build`, then copies **`dist/src/runtime`** → **`dist/runtime`** and **`dist/src/reporting/public`** → **`dist/reporting/public`**, and runs **`bun build --compile`** on `src/cli.ts` → **`dist/jaiph`**. Requires [Bun](https://bun.sh). Ship the **`dist/`** tree (binary plus those sibling directories) for a self-contained layout. |
| `npm test` | **`npm run clean`**, then **`npm run build`**, then the Node.js test runner with **`NODE_OPTIONS`** including **`--enable-source-maps`** (and a large heap limit) on `dist/test/*.test.js` and every file under `dist/src/` matching `*.test.js` or `*.acceptance.test.js` (via `find`). |
| `npm run test:acceptance:compiler` | **`npm run build`**, then **`node --test`** on only `dist/src/**/*.acceptance.test.js` — compiler acceptance tests without the full unit suite or E2E. |
| `npm run test:acceptance:runtime` | **`bash ./e2e/test_all.sh`** only — same E2E driver as below **without** an implicit rebuild; ensure `dist/` is up to date before running. |
| `npm run test:acceptance` | **`npm run test:acceptance:compiler`** then **`npm run test:acceptance:runtime`**. |
| `npm run test:e2e` | **`npm run build`**, then **`bash ./e2e/test_all.sh`**. Prefer this when you want a fresh `dist/` before E2E. |
| `npm run test:samples` | **`npx playwright test`** — Playwright suite for the docs landing page (`tests/e2e-samples/`). Uses `http://127.0.0.1:4000` (see `playwright.config.ts`); starts Jekyll via `webServer` or reuses one already on that port. Requires Playwright (`npx playwright install chromium` once). |
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
| **Compiler golden tests** | `src/transpile/compiler-golden.test.ts` (colocated) | Regressions in the parser, validation messages, and scripts-only extraction (`buildScriptFiles` in `emit-script.ts`) — expectations are inline in the test file | You changed the parser, validator, or script extraction and need to lock an exact error string, extracted script shape, or corpus behavior |
| **Cross-cutting tests** | `test/*.test.ts` | Process-level integration behavior: signal handling, TTY rendering, run summary structure, sample builds | The test spans multiple modules or requires subprocess/PTY harnesses |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the workflow actually execute correctly end-to-end? | The behavior involves the CLI launcher, Node runtime, process lifecycle, or file artifacts |

### Key principles

1. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
2. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
3. **Golden tests are the compiler's safety net.** After transpiler changes, run `npm test`. Failures in `src/transpile/compiler-golden.test.ts` usually mean updating an explicit expected string or fixture in that file — there is no separate dump script; align expectations with intentional emitter changes and re-run `npm test`.
4. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
5. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an E2E test. E2E tests are expensive to run and hard to debug — reserve them for integration-level behavior.

### Module test layout (colocated)

Module tests live next to the source files they validate, inside the same `src/` tree. Names are **`*.test.ts`** or **`*.acceptance.test.ts`**. To list them from the repo root:

```bash
find src -type f \( -name '*.test.ts' -o -name '*.acceptance.test.ts' \) | sort
```

The table below is the inventory as of this writing; after large refactors, prefer the `find` command above over assuming this list is exhaustive.

| Test file | Source / focus |
|-----------|----------------|
| `src/cli/commands/format-params-display.test.ts` | `format-params.ts` — parameter display helpers |
| `src/cli/run/display.test.ts` | `display.ts` — `colorize`, progress line formatting |
| `src/cli/run/events.test.ts` | `events.ts` — `parseLogEvent`, `parseStepEvent` for `__JAIPH_EVENT__` JSON lines |
| `src/cli/run/hooks.test.ts` | `hooks.ts` — hook discovery, merge, `runHooksForEvent` |
| `src/cli/run/lifecycle.test.ts` | `lifecycle.ts` — `waitForRunExit` and child exit handling |
| `src/cli/run/non-tty-heartbeat.test.ts` | Non-TTY runs — long-step heartbeat line shape |
| `src/cli/run/resolve-env.test.ts` | `env.ts` — workspace resolution, config defaults, env precedence |
| `src/cli/run/stderr-handler.test.ts` | `stderr-handler.ts` — TTY subscriber / stderr routing |
| `src/cli/shared/errors.test.ts` | `errors.ts` — `summarizeError`, failure metadata |
| `src/cli/shared/paths.test.ts` | `paths.ts` — `detectWorkspaceRoot` |
| `src/parse/parse-core.test.ts` | `core.ts` — low-level parse helpers (`stripQuotes`, `isRef`, brace depth, `fail`, …) |
| `src/parse/parse-definitions.test.ts` | Parser — invalid `rule` / `script` / `workflow` declarations and fix hints |
| `src/parse/parse-env.test.ts` | `env.ts` — env declaration parsing |
| `src/parse/parse-imports.test.ts` | `imports.ts` — import lines, aliases, errors |
| `src/parse/parse-metadata.test.ts` | `metadata.ts` — config block parsing |
| `src/parse/parse-run-async.test.ts` | Parser — `run async` workflow steps |
| `src/reporting/reporting-server.test.ts` | Reporting server — paths, `run_summary.jsonl`, registry |
| `src/runtime/docker.test.ts` | `docker.ts` — mounts, `buildDockerArgs` |
| `src/runtime/kernel/emit.test.ts` | `emit.ts` — `__JAIPH_EVENT__` JSON and `run_summary.jsonl` append |
| `src/runtime/kernel/graph.test.ts` | `graph.ts` — `buildRuntimeGraph`, symbol lookup |
| `src/runtime/kernel/mock.test.ts` | `mock.ts` — test-mode mock dispatch |
| `src/runtime/kernel/node-test-runner.test.ts` | `node-test-runner.ts` — e.g. `buildRuntimeGraph` once per test file (see [Testing](testing.md)) |
| `src/runtime/kernel/node-workflow-runtime.artifacts.test.ts` | `node-workflow-runtime.ts` — step `.out` / artifact behavior with mocked prompt |
| `src/runtime/kernel/prompt.test.ts` | `prompt.ts` — kernel prompt execution and mocks |
| `src/runtime/kernel/schema.test.ts` | `schema.ts` — prompt schema validation |
| `src/runtime/kernel/seq-alloc.test.ts` | `seq-alloc.ts` — `.seq` atomic allocation |
| `src/runtime/kernel/stream-parser.test.ts` | `stream-parser.ts` — streaming JSON from agents |
| `src/runtime/kernel/workflow-launch.test.ts` | `workflow-launch.ts` — `buildRunModuleLaunch` argv (Node runner) |
| `src/transpile/compiler-edge.acceptance.test.ts` | Cross-module — validation, resolution, multi-file builds |
| `src/transpile/compiler-golden.test.ts` | `transpiler.ts`, `emit-script.ts`, parser — golden cases and corpus |
| `src/transpile/emit-script.test.ts` | `emit-script.ts` — `normalizeShellLocalExport`, `resolveShellRefs` |
| `src/transpile/validate-managed-calls.test.ts` | `validate.ts` — `E_VALIDATE` (e.g. disallowed constructs) |
| `src/transpile/validate-run-async.test.ts` | Validation — `run async` restrictions |
| `src/transpile/validate-string.test.ts` | `validate-string.ts` / `buildScripts` — string interpolation and related errors |

**Kernel — `emit.ts`:** **`src/runtime/kernel/emit.ts`** handles **`live`** progress JSON to stderr and **`summary-line`** appends to `run_summary.jsonl`. **`appendRunSummaryLine`** uses shared **`mkdir`-style locking** from **`fs-lock.ts`**.

**Kernel — `seq-alloc.ts`:** **`src/runtime/kernel/seq-alloc.ts`** is the single owner of step-sequence allocation. It reads, increments, and writes the `.seq` file under the run directory atomically using `mkdir`-style locking from **`fs-lock.ts`** (same mechanism as `emit.ts` and `inbox.ts`). Colocated test: `seq-alloc.test.ts`.

**Kernel — `inbox.ts`:** **`src/runtime/kernel/inbox.ts`** implements file-backed **init**, **send**, **register-route**, and **drain** under the run directory’s `inbox/` subdirectory, including **`INBOX_*` `run_summary.jsonl`** lines and parallel **`inbox/.seq.lock`** behavior. There is no colocated `inbox.test.ts` yet; behavior is covered by **E2E** (e.g. inbox dispatch and run-summary contract tests).

**Kernel — `run-step-exec.ts`:** Managed script subprocess execution lives in **`src/runtime/kernel/run-step-exec.ts`**. There is no colocated `run-step-exec.test.ts` yet; behavior is covered by the **E2E** suite and runtime integration. Prefer adding focused unit tests if you extract pure helpers from the spawn/capture path.

**Kernel — `node-test-runner.ts`:** **`src/runtime/kernel/node-test-runner.ts`** executes `*.test.jh` test blocks using `NodeWorkflowRuntime` with mock support (prompt queues, content-based dispatch, workflow/rule/script body replacements) and assertion evaluation. Pure Node harness — no Bash test transpilation. Language-level semantics: [Testing](testing.md).

When adding a new source module or extending an existing one, create or extend the corresponding `*.test.ts` file in the same directory. This keeps tests discoverable — given a source file, the test file is always a sibling.

### Reference validation: ensure, run, and send RHS

After parse, **`validateReferences`** runs inside **`emitScriptsForModule`** (invoked from **`buildScripts()`**), before script files are written — the runtime graph loader does **not** re-run it (see [Architecture](../ARCHITECTURE.md)). The transpiler checks that `ensure` and `run` targets (and related refs, such as send right-hand sides) resolve to symbols of the right kind in the current or imported module. Implementation: **`src/transpile/validate.ts`**, with **local vs `alias.name` resolution**, **wrong-kind** messages, and **`lookupKind`** in **`src/transpile/validate-ref-resolution.ts`**. If you change validation behavior, treat **exact `E_VALIDATE` strings** as part of the public contract unless you are deliberately shipping a breaking change — verify with `npm test`, compiler golden tests, and `npm run test:e2e`.

### Script extraction only (no workflow bash modules)

The **production compile path** matches [Architecture](../ARCHITECTURE.md): for each module, **`emitScriptsForModule`** runs **`parsejaiph`**, **`validateReferences`**, then **`buildScriptFiles`** in **`src/transpile/emit-script.ts`**. That writes **only** standalone bash files for each **`script` block** (shebang, `set -euo pipefail`, body with `resolveShellRefs` / `normalizeShellLocalExport`). There is **no** workflow-level shell module, no per-workflow `.sh` orchestration layer, and **no** bash emitter for rules or workflow steps — **`NodeWorkflowRuntime`** interprets the AST for all execution.

**Compiler golden tests** (`src/transpile/compiler-golden.test.ts`) lock **parser** and **validation** errors, **`buildScriptFiles`** output, fixture corpus builds, and related regressions — not a legacy “full emitted workflow module” string. If you change extraction or validation, treat expected strings and regexes as contracts; run `npm test` and `npm run test:e2e`.

### Cross-cutting tests in `test/`

Tests that span multiple modules, require subprocess/PTY harnesses, or exercise process-level behavior remain in `test/`. These do not belong to a single module:

| Test file | Kind | What it covers |
|-----------|------|----------------|
| `sample-build.test.ts` | Integration | Cross-module build/transpile/run-tree behavior using real compiler and CLI components |
| `run-summary-jsonl.test.ts` | Integration | Runs the CLI on a small workflow and asserts structure and fields of `run_summary.jsonl` under `.jaiph/runs/` |
| `signal-lifecycle.test.ts` | Acceptance | After SIGINT/SIGTERM, verifies `jaiph run` exits within a time bound and leaves no stale child processes |
| `tty-running-timer.test.ts` | Acceptance | In a TTY, verifies the “RUNNING workflow” line updates over time (requires Python 3 PTY harness) |

Shared test data (`test/fixtures/`, `test/expected/`) also remains in `test/`.

## CI pipeline

The project uses GitHub Actions (`.github/workflows/ci.yml`). Every push triggers four jobs:

| Job | Runner | Purpose |
|-----|--------|---------|
| **Compiler and unit tests** | `ubuntu-latest` | `npm test` (TypeScript unit + acceptance + golden tests), plus a `curl` check that the public install URL responds and a git-tag verification on `main`. |
| **E2E install and CLI workflow** | `ubuntu-latest`, `macos-latest` (matrix) | `npm run test:e2e` — full build-and-run E2E suite on each OS. |
| **Getting started (local)** | `ubuntu-latest` | Builds and serves the Jekyll documentation site locally (`bundle exec jekyll serve` on `127.0.0.1:4000`), waits for it to respond, smoke-checks key pages with `curl`, then runs the **Playwright landing-page sample verification** (`npx playwright test`). The Playwright step builds Jaiph, extracts sample source and expected output from the served HTML, verifies source parity with `examples/*.jh`, and runs deterministic samples through the CLI. No dependency on `jaiph.org`. |
| **E2E install and CLI workflow (windows-latest + wsl)** | `windows-latest` | Detects an available WSL distro, installs Node inside it, and runs `npm run test:e2e` under WSL. Skipped when no distro is present on the runner image. |

### Local docs site (Jekyll)

The **Getting started (local)** CI job validates that the documentation site under `docs/` can be built and served from source. It uses Ruby 3.2 with `bundler-cache`, runs `bundle exec jekyll serve --host 127.0.0.1 --port 4000` in the background, and polls `http://127.0.0.1:4000/` for up to 30 seconds before asserting HTTP 200 on `/` and `/getting-started`.

To run the same check locally:

```bash
cd docs
bundle install          # first time only
bundle exec jekyll serve --host 127.0.0.1 --port 4000
# In another terminal:
curl -fsSL http://127.0.0.1:4000/
```

The Jekyll project lives entirely inside `docs/` — `Gemfile`, `_config.yml`, layouts, and all Markdown pages.

### Landing-page sample verification (Playwright)

After the Jekyll smoke-check, the CI job also verifies that code samples shown on the landing page match real CLI behavior. This uses Playwright (Chromium) with a test suite in `tests/e2e-samples/landing-page.spec.ts`.

The test does two things:

1. **Source parity** — extracts each sample's source code from the DOM (`[data-sample-source]` elements inside `[data-sample]` tab panels) and compares it byte-for-byte against the corresponding file in `examples/` (identified by `data-sample-file`).
2. **Output verification** — for deterministic samples (currently `say_hello.jh` failure path and `agent_inbox.jh`), runs the workflow via `node dist/src/cli.js run` and asserts that key output lines match what the page displays (`[data-sample-output]` blocks), after normalizing ANSI codes, timestamps, and trailing whitespace.

To run locally:

```bash
npm run test:samples
```

If a Jekyll server is already running on **`http://127.0.0.1:4000`**, Playwright reuses it (`reuseExistingServer` in `playwright.config.ts`). Otherwise it starts one.

Samples that require live agent backends (e.g. `async.jh`, `ensure_ci_passes.jh`) are verified for source parity only — output verification is limited to fully deterministic workflows.

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

# Given — create the workflow file inline (script + workflow; same shape as e2e/tests/10_basic_workflows.sh)
e2e::file "hello.jh" <<'EOF'
script hello_impl {
  echo "hello-jh"
}
workflow default {
  msg = run hello_impl()
  return "${msg}"
}
EOF

# When — build and run
hello_out="$(e2e::run "hello.jh")"

# Then — assert on CLI tree output
e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
  ▸ script hello_impl
  ✓ script hello_impl (<time>)
✓ PASS workflow default (<time>)
EOF

# Then — assert on run artifacts
e2e::expect_out_files "hello.jh" 2
e2e::expect_out "hello.jh" "hello_impl" "hello-jh"
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

After a workflow runs, its step outputs are written as files under `.jaiph/runs/`. Each artifact file is named with a zero-padded sequence prefix reflecting step execution order (e.g. `000001-module__step.out`, `000002-module__step.err`). The sequence counter is file-backed (`.seq` under the run directory) and allocated atomically by **`src/runtime/kernel/seq-alloc.ts`** (compiled into the kernel shipped with the CLI) so concurrent async branches (`run async`) each receive a unique monotonic prefix — no two steps share a `seq` within the same run. This makes file names predictable and ordered, so tests can assert on exact file names without glob matching. These helpers verify the content of those files, catching bugs in the runtime's output-capture pipeline independently from what the CLI displays.

| Helper | Description |
|--------|-------------|
| `e2e::expect_out_files "file" N` | Assert that the run directory for `file` contains exactly `N` `.out` files. Use `0` for steps with no stdout (e.g. `touch`, `test`, redirected output). |
| `e2e::expect_out "file" "step" "expected"` | Assert that the `.out` file for the named step (script, rule, or `default` workflow bucket) matches `expected` exactly. |
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

### Auditing `e2e::assert_contains`

Some tests still use **`e2e::assert_contains`** when full equality is impractical (nondeterministic or platform-dependent output, variable-length logs, or evolving CLI text). That is allowed **only** with an **inline comment** next to the call explaining why — same policy as [Architecture](../ARCHITECTURE.md#e2e-test-philosophy-and-artifact-layout). The list of files and line numbers changes often; **do not** treat a frozen table in this doc as authoritative. To see current usages from the repo root:

```bash
rg 'e2e::assert_contains' e2e/tests -n
```

When you add or tighten a test, prefer **full-equality** helpers first; add substring checks only when one of the documented exceptions applies.

### Why both tree output and artifact assertions?

Tree output assertions (`e2e::expect_stdout`) verify what the **user sees** in the terminal. Artifact assertions (`e2e::expect_out`, `e2e::expect_file`) verify what the **runtime persists** to disk. A bug could break one without affecting the other — for example, the CLI could display correct output while the runtime silently fails to write the `.out` file, or vice versa.
