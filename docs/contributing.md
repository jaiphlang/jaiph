---
title: Contributing
permalink: /contributing
redirect_from:
  - /contributing.md
---

# Contributing to Jaiph

Open-source projects depend on clear repo conventions: how to build, test, and propose changes. **This page is that map for Jaiph** — branches, installing from a clone, code philosophy, **test strategy** (layers, TypeScript layout, E2E philosophy, bash harness), and CI. It does **not** teach the language; for that, use [Getting Started](getting-started.md) (documentation map), [Setup](setup.md) (install and workspace), and [Grammar](grammar.md). For **how the implementation is structured** (components, build pipeline, runtime contracts, artifact paths on disk), see [Architecture](architecture).

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
| `npm run build` | Runs `tsc`, then copies **`src/runtime`** → **`dist/src/runtime`** (kernel JS for the compiled CLI). |
| `npm run build:standalone` | `npm run build`, then copies **`dist/src/runtime`** → **`dist/runtime`** and runs **`bun build --compile`** on `src/cli.ts` → **`dist/jaiph`**. Requires [Bun](https://bun.sh). Ship the **`dist/`** tree (binary plus the runtime directory) for a self-contained layout. |
| `npm test` | **`npm run clean`**, then **`npm run build`**, then the Node.js test runner with **`NODE_OPTIONS`** including **`--enable-source-maps`** (and a large heap limit) on `dist/test/*.test.js`, every file under `dist/src/` matching `*.test.js` or `*.acceptance.test.js` (via `find`), `dist/src/compiler-test-runner.js` (txtar compiler tests), and `dist/src/golden-ast-runner.js` (golden AST tests). |
| `npm run test:compiler` | **`npm run build`**, then **`node --test`** on `dist/src/compiler-test-runner.js` — runs txtar-based compiler test fixtures from `compiler-tests/`. |
| `npm run test:golden-ast` | **`npm run build`**, then **`node --test`** on `dist/src/golden-ast-runner.js` — runs golden AST tests from `golden-ast/`. Use `UPDATE_GOLDEN=1 npm run test:golden-ast` to regenerate goldens after intentional parser changes. |
| `npm run test:acceptance:compiler` | **`npm run build`**, then **`node --test`** on only `dist/src/**/*.acceptance.test.js` — compiler acceptance tests without the full unit suite or E2E. |
| `npm run test:acceptance:runtime` | **`bash ./e2e/test_all.sh`** only — same E2E driver as below **without** an implicit rebuild; ensure `dist/` is up to date before running. |
| `npm run test:acceptance` | **`npm run test:acceptance:compiler`** then **`npm run test:acceptance:runtime`**. |
| `npm run test:e2e` | **`npm run build`**, then **`bash ./e2e/test_all.sh`**. Prefer this when you want a fresh `dist/` before E2E. By default this exercises the **Docker** sandbox when `JAIPH_UNSAFE` is unset. For a faster host-only run (no container), use **`JAIPH_UNSAFE=true npm run test:e2e`**. |
| `npm run test:samples` | **`npx playwright test`** — Playwright suite for the docs landing page (`tests/e2e-samples/`). Uses `http://127.0.0.1:4000` (see `playwright.config.ts`); starts Jekyll via `webServer` or reuses one already on that port. Requires Playwright (`npx playwright install chromium` once). |
| `npm run test:ci` | `npm test` followed by `npm run test:e2e` — useful before pushing when you want the full local picture. |

Run a single Node test file after a build with e.g. `node --test dist/src/parse/parse-core.test.js`. The `dist/` paths mirror the source layout under `src/`.

## Workspace hygiene

The root `.gitignore` blocks common debug and temp directory patterns so they never reach version control:

| Pattern | Purpose |
|---------|---------|
| `docker-*/` | Leftover Docker debug/experiment directories |
| `nested-*/` | Nested-run debug directories |
| `overlay-*/` | Overlay/fuse debug directories |
| `local-*/` | Local debug directories |
| `.tmp*/` | Temp build/debug directories |
| `QUEUE.md.tmp.*` | Stale queue temp files |

If you create throwaway directories during development, use one of these prefixes so they are automatically ignored. To track a file that matches a blocked pattern, use `git add -f`.

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
| **Compiler tests (txtar)** | `compiler-tests/*.txt` | Parse and validate outcomes — success, parse errors, validation errors — using language-agnostic txtar fixtures (200 cases across 4 fixture files) | You want a portable test case that can be reused by alternative compiler implementations; the test is a `.jh` input paired with an expected outcome |
| **Golden AST tests** | `golden-ast/fixtures/*.jh` + `golden-ast/expected/*.json` | Parse tree shape for successful parses — serialized to deterministic JSON with locations stripped (8 fixtures covering catch, imports, log, match, params, prompt-capture, run-ensure, script-defs) | You changed the parser and need to verify the AST structure hasn't drifted; txtar tests only check pass/fail, goldens lock in the actual tree shape |
| **Cross-cutting tests** | `test/*.test.ts` | Process-level integration behavior: signal handling, TTY rendering, run summary structure, sample builds | The test spans multiple modules or requires subprocess/PTY harnesses |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the workflow actually execute correctly end-to-end? | The behavior involves the CLI launcher, Node runtime, process lifecycle, or file artifacts |

### Key principles

1. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
2. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
3. **Golden tests are the compiler's safety net.** After transpiler changes, run `npm test`. Failures in `src/transpile/compiler-golden.test.ts` usually mean updating an explicit expected string or fixture in that file — there is no separate dump script; align expectations with intentional emitter changes and re-run `npm test`. **Golden AST tests** (`golden-ast/`) complement this by locking in the parse tree shape — if those fail, regenerate with `UPDATE_GOLDEN=1 npm run test:golden-ast` and review the diff.
4. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
5. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an E2E test. E2E tests are expensive to run and hard to debug — reserve them for integration-level behavior.

### TypeScript test layout

- **Module tests** — live next to the source they validate under `src/` (e.g. `src/parse/parse-core.test.ts`, `src/cli/run/display.test.ts`, `src/transpile/compiler-golden.test.ts`). Names are `*.test.ts` or `*.acceptance.test.ts`.
- **Cross-cutting tests** — span multiple modules or need subprocess/PTY harnesses; they stay in `test/` (see [Cross-cutting tests in `test/`](#cross-cutting-tests-in-test)).
- **E2E** — bash scripts in `e2e/tests/*.sh`, driven by `e2e/test_all.sh`.
- **`npm test`** discovers colocated files under `src/` and everything in `test/`; see the [Developing in the repository](#developing-in-the-repository) table for the exact command.

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

When adding a new source module or extending an existing one, create or extend the corresponding `*.test.ts` file in the same directory. This keeps tests discoverable — given a source file, the test file is always a sibling.

For details on kernel module internals (`emit.ts`, `seq-alloc.ts`, `run-step-exec.ts`, `node-test-runner.ts`), the compile pipeline, and validation contracts, see [Architecture](architecture).

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
| **E2E install and CLI workflow** | Matrix: **`ubuntu-latest` twice** + **`macos-latest`** | `npm run test:e2e` — full build-and-run E2E suite. **Ubuntu — docker:** `JAIPH_UNSAFE` unset (default Docker sandbox, pulls `ghcr.io/jaiphlang/jaiph-runtime`). **Ubuntu — host:** `JAIPH_UNSAFE=true` (host execution, no Docker). **macOS — host:** `JAIPH_UNSAFE=true` (macOS runners are not used for the Docker path). |
| **Getting started (local)** | `ubuntu-latest` | Builds and serves the Jekyll documentation site locally (`bundle exec jekyll serve` on `127.0.0.1:4000`), waits for it to respond, smoke-checks key pages with `curl`, then runs the **Playwright landing-page sample verification** (`npx playwright test`). The Playwright step builds Jaiph, extracts sample source and expected output from the served HTML, verifies source parity with `examples/*.jh`, and runs deterministic samples through the CLI. No dependency on `jaiph.org`. |
| **E2E install and CLI workflow (windows-latest + wsl)** | `windows-latest` | Detects an available WSL distro, installs Node inside it, and runs `npm run test:e2e` under WSL with **`JAIPH_UNSAFE=true`** (host-only, matching the previous default). Skipped when no distro is present on the runner image. |

### npm publish on tag (trusted publishing)

Pushing a version tag (`v*`) triggers `.github/workflows/release.yml`, which publishes to npm using **trusted publishing** (OIDC). No classic `NPM_TOKEN` secret is stored in the repo. After a successful publish, a smoke job installs `jaiph` globally and verifies `--version` and `--help` match expectations. The npm package must have trusted publishing enabled for the `jaiphlang/jaiph` repo and `release.yml` workflow on npmjs.com.

### Local docs site (Jekyll)

The **Getting started (local)** CI job validates that the documentation site under `docs/` can be built and served from source. It uses Ruby 3.2 with `bundler-cache`, runs `bundle exec jekyll serve --host 127.0.0.1 --port 4000` in the background, and polls `http://127.0.0.1:4000/` for up to 30 seconds before asserting HTTP 200 on `/`, `/getting-started`, `/setup`, `/libraries`, and `/artifacts`.

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

Samples that require live agent backends (e.g. `async.jh`, `recover_loop.jh`) are verified for source parity only — output verification is limited to fully deterministic workflows.

## E2E testing

The E2E test suite (`e2e/tests/*.sh`) exercises the full build-and-run pipeline from the outside: compile a workflow, run it, and assert on both the CLI tree output and the run artifact files (`.out`, `.err`) written to `.jaiph/runs/`.

Some scripts are **contract** tests: they validate persisted machine-readable output (for example `e2e/tests/88_run_summary_event_contract.sh` and `run_summary.jsonl`) in addition to or instead of golden CLI trees.

### E2E philosophy: two surfaces and full equality

E2E tests are the outermost **behavior contracts** for the CLI and runtime. Each test should exercise the real pipeline and assert on **two independent surfaces**:

1. **CLI tree output** — what the user sees (`e2e::expect_stdout` with a heredoc).
2. **Run artifacts** — what the runtime persists under `.jaiph/runs/<date>/<source>/` (`e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`). Inbox files live under the run directory when the feature touches inbox behavior.

**Default contract:** every assertion should compare the **full** expected text (stdout heredoc, artifact file contents, JSONL lines) unless there is a documented exception. Use `e2e::expect_stdout`, `e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`, or `e2e::assert_equals` / `e2e::assert_output_equals` for full comparisons.

`e2e::assert_contains` (substring check) is allowed **only** when full equality is not feasible. Every such use must have an inline comment explaining why. Valid reasons:

- **Nondeterministic output** — e.g. prompt transcripts with real agent backends, timestamps not covered by `<time>` normalization.
- **Unbounded or variable-length logs** — e.g. `run_summary.jsonl` with platform-dependent event counts, or live step output where line count varies.
- **Platform-dependent text** — e.g. OS-specific error messages, paths that differ across CI environments.

**Normalization:** `e2e::normalize_output` (in `e2e/lib/common.sh`) strips ANSI codes and replaces timing values with `<time>`, agent commands with `<agent-command>`, and script paths with `<script-path>`. This keeps full-equality heredocs stable across machines.

**Where files land on disk** (directory tree, sequence prefixes): [Architecture — Durable artifact layout](architecture#durable-artifact-layout). Runtime testing with `*.test.jh` is covered in [Testing](testing.md). The `run_summary.jsonl` event contract is exercised in `e2e/tests/88_run_summary_event_contract.sh`.

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
script hello_impl = `echo "hello-jh"`
workflow default() {
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

After a workflow runs, its step outputs are written as sequenced artifact files under `.jaiph/runs/`. These helpers verify artifact content independently from CLI display output. For the on-disk layout and naming scheme, see [Architecture — Durable artifact layout](architecture#durable-artifact-layout).

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

### Assertion policy

Quick reference: default to **full-equality** helpers (`e2e::expect_stdout`, `e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`, `e2e::assert_equals`). `e2e::assert_contains` is the exception — every use needs an inline comment; rationale list in **E2E philosophy** above. Audit substring usage:

```bash
rg 'e2e::assert_contains' e2e/tests -n
```

### Orphan sample guard

Every `.jh` and `.test.jh` file under `e2e/` must be referenced by at least one test script (`e2e/tests/*.sh`, `e2e/test_all.sh`, or `e2e/lib/`). Unreferenced samples confuse contributors, hide drift from the canonical `examples/` corpus, and make it unclear which fixtures are load-bearing.

The guard script `e2e/check_orphan_samples.sh` detects orphans automatically. It scans every `.jh` and `.test.jh` file under `e2e/`, checks whether its basename appears in any test runner or helper, and also resolves indirect references (a file imported by another `.jh` that is itself referenced counts as covered). Any file that is neither directly nor indirectly referenced is reported as an orphan.

```bash
# Run manually from the repo root
bash e2e/check_orphan_samples.sh
```

On success the script prints `OK: no orphan e2e samples detected.` and exits 0. On failure it lists the unreferenced filenames and exits 1, with guidance to either wire them into a test, move them to `examples/`, or delete them.

When adding a new `.jh` fixture to `e2e/`, make sure it is exercised by a test in `e2e/tests/` or imported by a file that is. If a sample exists purely for documentation or demonstration purposes, it belongs in `examples/` instead.

### Example matrix guard

Every `.jh` and `.test.jh` file under `examples/` must be accounted for in `e2e/tests/110_examples.sh`. The script maintains three arrays that together form the example matrix:

| Array | Purpose |
|-------|---------|
| `COVERED_RUN` | Examples exercised via `jaiph run` with strict `e2e::expect_stdout` assertions. |
| `COVERED_TEST` | Test companions (`*.test.jh`) exercised via `jaiph test`. |
| `EXCLUDED` | Files that cannot run in E2E (e.g. CI-specific, require real agent backends). Each entry must have an inline comment explaining why. |

An orphan guard at the bottom of the script fails CI if any example file is not listed in one of the three arrays. To add a new example:

1. Place the `.jh` file in `examples/`.
2. Add it to `COVERED_RUN`, `COVERED_TEST`, or `EXCLUDED` (with a comment).
3. If covered, add a test section with strict `e2e::expect_stdout` and artifact assertions.
