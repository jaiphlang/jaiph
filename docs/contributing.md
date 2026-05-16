---
title: Contributing
permalink: /contributing
redirect_from:
  - /contributing.md
---

# Contributing to Jaiph

Contributor docs answer a narrow question: **where changes belong**, **how to run the same checks CI runs**, and **which test layer** should encode a behavior change.

At a high level, Jaiph is built as described in [Architecture](architecture.md) — single-graph transpile path (`loadModuleGraph` → `validateReferences(graph)` → `emitScriptsForModuleFromGraph` / `buildScriptsFromGraph`), graph-consuming **`buildRuntimeGraph(graph)`**, **`jaiph compile`** (validate-only), **`NodeWorkflowRuntime`**, artifact layout, and Docker helper contracts. Treat that page as authoritative for pipelines and boundaries; if anything here diverges from it or from the implementation, prefer **architecture + source**.

For workflow syntax, library usage, tooling setup, and grammar details, see [Language](language.md), [Setup](setup.md), [Grammar](grammar.md), and the overview in [Getting Started](getting-started.md).

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

**Prerequisites:** Node.js **20.x** and npm (same **`setup-node`** version as `.github/workflows/ci.yml`). The installers also expect `git` and `bash`. End-to-end tests are written in bash and are run by `e2e/test_all.sh`.

**Typical commands** (from the repo root):

| Command | What it runs |
|---------|----------------|
| `npm install` | Installs TypeScript and types (dev dependencies). |
| `npm run build` | Runs `tsc`, then copies **`src/runtime`** → **`dist/src/runtime`** (kernel JS for the compiled CLI) and **`runtime/overlay-run.sh`** → **`dist/src/runtime/overlay-run.sh`** (Docker overlay entrypoint). |
| `npm run build:standalone` | `npm run build`, then copies **`dist/src/runtime`** → **`dist/runtime`** and runs **`bun build --compile ./src/cli.ts --outfile ./dist/jaiph`**. Requires [Bun](https://bun.sh). Ship **`dist/jaiph`** beside **`dist/runtime`** ([Architecture — Distribution](architecture.md#distribution-node-vs-bun-standalone)). |
| `npm test` | **`npm run clean`**, then **`npm run build`**, then the Node.js test runner with **`JAIPH_UNSAFE=true`**, **`NODE_OPTIONS`** including **`--enable-source-maps`** and a large heap limit, on every file under `dist/integration/` matching `*.test.js`, every file under `dist/src/` matching `*.test.js` or `*.acceptance.test.js` (via `find`), `dist/test-infra/compiler-test-runner.js` (txtar compiler tests), and `dist/test-infra/golden-ast-runner.js` (golden AST tests). |
| `npm run test:compiler` | **`npm run build`**, then **`node --test`** on `dist/test-infra/compiler-test-runner.js` — runs txtar-based compiler test fixtures from `test-fixtures/compiler-txtar/`. |
| `npm run test:golden-ast` | **`npm run build`**, then **`node --test`** on `dist/test-infra/golden-ast-runner.js` — runs golden AST tests from `test-fixtures/golden-ast/`. Use `UPDATE_GOLDEN=1 npm run test:golden-ast` to regenerate goldens after intentional parser changes. |
| `npm run test:acceptance:compiler` | **`npm run build`**, then **`node --test`** with only `*.acceptance.test.js` files under **`dist/src/`** (same `find … -name '*.acceptance.test.js'` fragment as **`package.json`**) — compiler acceptance tests without the full unit suite or E2E. |
| `npm run test:acceptance:runtime` | **`bash ./e2e/test_all.sh`** only — same E2E driver as below **without** an implicit rebuild; ensure `dist/` is up to date before running. |
| `npm run test:acceptance` | **`npm run test:acceptance:compiler`** then **`npm run test:acceptance:runtime`**. |
| `npm run test:e2e` | **`npm run build`**, then **`bash ./e2e/test_all.sh`**. Prefer this when you want a fresh `dist/` before E2E. **`e2e::prepare_shared_context`** in `e2e/lib/common.sh` exports **`JAIPH_DOCKER_ENABLED=false`** after clearing most **`JAIPH_*`** variables, so typical tests run on the **host**; Docker coverage lives in scripts that set **`JAIPH_DOCKER_ENABLED=true`** — see [E2E testing](#e2e-testing) and **`resolveDockerConfig`** in `src/runtime/docker.ts` / [Architecture — Core components](architecture.md#core-components). |
| `npm run test:samples` | **`npx playwright test`** — Playwright suite for the docs landing page (`e2e/playwright/`). Uses `http://127.0.0.1:4000` (see `playwright.config.ts`); starts Jekyll via `webServer` or reuses one already on that port. Requires Playwright (`npx playwright install chromium` once). |
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
| **Trivia / formatter round-trip** | `src/parse/trivia-ast-shape.test.ts`, `src/parse/trivia-grep.test.ts`, `src/format/roundtrip.test.ts` | Source-fidelity invariants: no trivia fields on semantic AST types (compile-time), validator/emitter sources do not reference `Trivia`, and `parse → format → parse → format` is bit-for-bit on every fixture under `examples/` and `test-fixtures/golden-ast/fixtures/` | You changed the parser, formatter, AST types, or anything that touches source-fidelity round-trip (see [Architecture — Trivia (CST layer)](architecture.md#trivia-cst-layer)) |
| **Call-args AST shape** | `src/parse/arg-ast-shape.test.ts`, `src/parse/arg-grep.test.ts` | Pins the typed-`Arg[]` invariant: no `bareIdentifierArgs` field on any call-bearing AST type (compile-time), no `args.split(",")` or `bareIdentifierArgs` text in production `src/parse/` or `src/transpile/` sources, and no `validateBareIdentifierArgs` helper in the validator | You changed how call arguments flow through the parser, validator, or emitter and need to confirm nothing re-introduces the parallel raw-string representation (see [Architecture — AST / Types](architecture.md#core-components)) |
| **`Expr` / step-variant shape** | `src/types-shape.test.ts` | Pins the collapsed-AST invariants from the `Expr` refactor: exactly 8 `WorkflowStepDef` variants and exactly 8 `Expr` kinds (compile-time exhaustive switch + runtime tuple count), no AST placeholder strings (`"__match__"`, `"run inline_script"`, `"__JAIPH_MANAGED__"`) anywhere under `src/`, and `ConstRhs` / `SendRhsDef` no longer exported from `src/types.ts` | You added or renamed a step variant or `Expr` kind, or reshuffled how value positions are encoded; rerun this test to confirm nothing re-introduces the three-way "managed call" encoding (see [Architecture — AST / Types](architecture.md#core-components)) |
| **Validator single-walk shape** | `src/transpile/validate-single-walk.test.ts` | Pins the validator's "one descent per workflow / rule" invariant: a name-grep fails if `collectKnownVars`, `collectPromptSchemas`, or `validateImmutableBindings` reappear as separate helpers in `validate.ts`, and a textual AST scan fails if more than one recursive helper walking `WorkflowStepDef[]` lives in that file | You touched `walkStepTree`, added a new pre-pass over workflow steps, or restructured how the validator accumulates `knownVars` / `promptSchemas` / `bindings` — rerun this test to confirm the step tree is still descended exactly once (see [Architecture — Validator](architecture.md#core-components)) |
| **Validator visitor-table shape** | `src/transpile/validate-visitor.test.ts` | Pins the per-step visitor refactor: an LoC test caps `validate.ts` at **≤700 lines** so new per-step logic lands in `validate-step.ts` instead of the outer entry; a `JSON` snapshot over every `validate-*` txtar fixture (stored in `test-fixtures/compiler-txtar/validate-diagnostics-snapshot.json`) pins each diagnostic's `{ code, line, col, message }` bit-for-bit, so any drift in wording or location across the visitor table fails the test; an "unknown step type" test injects a synthetic `WorkflowStepDef.type` and asserts it produces exactly one `internal: no validator for step type "…"` diagnostic in both `WORKFLOW_SCOPE` and `RULE_SCOPE` — proving adding a new step type costs exactly one row in `VALIDATORS` | You touched the `VALIDATORS` table, changed `validateStep` / `validateExpr` / `validateCallable` / `Scope`, added or renamed a per-step validator in `validate-step.ts`, or changed any `E_VALIDATE` message wording or source location — refresh the snapshot with `UPDATE_SNAPSHOTS=1` only after confirming the message change is intentional (see [Architecture — Validator](architecture.md#core-components)) |
| **Compile-time / runtime layering** | `src/transpile/no-runtime-imports.test.ts`, `src/parse/canonicalize-triple-quoted.test.ts` | Pins the one-way dependency between compile-time and runtime: a grep over every non-test `*.ts` under `src/transpile/` fails if any `from "…/runtime/…"` import appears, so the validator cannot reach into runtime semantics; a corpus parity test parses every `.jh` under `test-fixtures/` and `examples/`, collects each triple-quoted match-arm body, and asserts `canonicalizeTripleQuotedString` matches the pre-move `tripleQuotedRawForRuntime` output bit-for-bit | You added a new helper used by both the validator and the runtime (it belongs in `src/parse/`, not `src/runtime/`), or you changed how triple-quoted match-arm bodies are canonicalized — rerun this test to confirm the validator stays decoupled from runtime code and the canonical form is unchanged (see [Architecture — Validator](architecture.md#core-components)) |
| **Diagnostics collector shape** | `src/transpile/diagnostics-collector.test.ts` | Pins the migration from fail-fast `throw jaiphError(...)` to the `Diagnostics` collector: a fixture with three independent errors (duplicate import alias, undefined channel, unknown `run` target) asserts that `collectDiagnostics(graph)` returns **all three** in source order; a source grep asserts `validate.ts` holds **zero** `throw jaiphError(` sites and many `diag.error(` sites; an allowlist scan over every non-test `*.ts` under `src/` rejects new `throw jaiphError(` sites outside the documented fatal subset (parser `fail()`, loader, test-file shape check, legacy bridge, four leaf helpers wrapped in `diag.capture(...)`); a CLI test asserts `jaiph compile --json` returns the full diagnostic array and exits non-zero | You added a new `throw jaiphError(...)` site, migrated more checks to the collector, changed the fatal/recoverable boundary, or changed `jaiph compile`'s exit-code or output shape (see [Architecture — Validator](architecture.md#core-components) and [CLI](cli.md)) |
| **Compiler tests (txtar)** | `test-fixtures/compiler-txtar/*.txt` | Parse and validate outcomes — success, parse errors, validation errors — using language-agnostic txtar fixtures (hundreds of `===` cases across the four `*.txt` files) | You want a portable test case that can be reused by alternative compiler implementations; the test is a `.jh` input paired with an expected outcome |
| **Golden AST tests** | `test-fixtures/golden-ast/fixtures/*.jh` + `test-fixtures/golden-ast/expected/*.json` | Parse tree shape for successful parses — serialized to deterministic JSON with locations stripped (9 fixtures: e.g. imports, brace-if, log, match and match-multiline, params, prompt-capture, run-ensure, script-defs) | You changed the parser and need to verify the AST structure hasn't drifted; txtar tests only check pass/fail, goldens lock in the actual tree shape |
| **Integration tests** | `integration/*.test.ts`, `integration/sample-build/*.test.ts` | Process-level integration behavior: signal handling, TTY rendering, run summary structure, sample builds | The test spans multiple modules or requires subprocess/PTY harnesses |
| **E2E tests** | `e2e/tests/*.sh` | Runtime behavior — does the workflow actually execute correctly end-to-end? | The behavior involves the CLI launcher, Node runtime, process lifecycle, or file artifacts |

### Key principles

1. **Compile-time validation vs graph loading.** `buildScripts` / `emitScriptsForModule` run **`validateReferences`** before any script files are written. **`buildRuntimeGraph()`** only parses modules and follows imports — it does **not** re-run that validation. Lock compile errors in the compiler/validator tests; the runtime graph is the wrong layer for that (see [Architecture — Core components](architecture.md#core-components)). **`jaiph compile`** runs **`validateReferences` only** (no **`buildScripts`**, no runner); cover it with txtar/acceptance/E2E such as `e2e/tests/109_compile_command.sh`, not by expecting the full transpile path — see [Architecture — System overview](architecture.md#system-overview).
2. **`jaiph test` vs live events.** **`jaiph test`** reuses **`NodeWorkflowRuntime`** with **`suppressLiveEvents: true`** so **`__JAIPH_EVENT__`** lines are **not** written to stderr alongside **`node --test`** output while **`run_summary.jsonl`** and other artifact paths stay consistent where the harness writes them ([Architecture — Test runner integration](architecture.md#test-runner-integration-testjh-in-the-kernel)).
3. **Tests are behavior contracts.** E2E tests and acceptance tests define what the product does. Default approach: change production code to satisfy tests, not the other way around.
4. **Modify existing tests only with a strong reason:** intentional product behavior change, incorrect test expectation, or removal of an obsolete feature. Any such change should be minimal and paired with a clear rationale.
5. **Golden tests are the compiler's safety net.** After transpiler changes, run `npm test`. Failures in `src/transpile/compiler-golden.test.ts` usually mean updating an explicit expected string or fixture in that file — there is no separate dump script; align expectations with intentional emitter changes and re-run `npm test`. **Golden AST tests** (`test-fixtures/golden-ast/`) complement this by locking in the parse tree shape — if those fail, regenerate with `UPDATE_GOLDEN=1 npm run test:golden-ast` and review the diff.
6. **E2E tests assert two things independently:** what the user sees (CLI tree output via `e2e::expect_stdout`) and what the runtime persists (artifact files via `e2e::expect_out`, `e2e::expect_file`). A bug could break one without the other.
7. **Prefer the narrowest test layer.** A pure function bug should be caught by a unit test, not an E2E test. E2E tests are expensive to run and hard to debug — reserve them for integration-level behavior.

### TypeScript test layout

- **Module tests** — live next to the source they validate under `src/` (e.g. `src/parse/parse-core.test.ts`, `src/cli/run/display.test.ts`, `src/transpile/compiler-golden.test.ts`). Names are `*.test.ts` or `*.acceptance.test.ts`.
- **Integration tests** — span multiple modules or need subprocess/PTY harnesses; they live in `integration/` (see [Integration tests](#integration-tests)).
- **E2E** — bash scripts in `e2e/tests/*.sh`, driven by `e2e/test_all.sh`.
- **`npm test`** discovers colocated files under `src/`, integration tests under `integration/`, and test infrastructure in `test-infra/`; see the [Developing in the repository](#developing-in-the-repository) table for the exact command.

### Module test layout (colocated)

Module tests live next to the source files they validate, inside the same `src/` tree. Names are **`*.test.ts`** or **`*.acceptance.test.ts`**. To list them from the repo root:

```bash
find src -type f \( -name '*.test.ts' -o -name '*.acceptance.test.ts' \) | sort
```

**Grouping (use the `find` output as authoritative after refactors):**

| Area | Typical location | What it usually covers |
|------|------------------|------------------------|
| Parser and tokenizer helpers | `src/parse/*.test.ts`, `src/parse/dedent.test.ts` | `.jh` / `.test.jh` surface: imports, config, steps, strings, channels, fences, `run async`, … |
| CLI and terminal UX | `src/cli/**/*.test.ts` | Commands, `jaiph run` lifecycle, progress, hooks, `resolve-env` |
| Transpiler and validation | `src/transpile/*.test.ts` + `*.acceptance.test.ts` | `validateReferences`, `emit`, golden compiler (`compiler-golden.test.ts`), cross-module edge cases (`compiler-edge.acceptance.test.ts`) |
| Formatter | `src/format/*.test.ts` | `jaiph format` |
| Runtime and Docker | `src/runtime/kernel/*.test.ts`, `src/runtime/docker.test.ts` | Graph, emit, prompts, test runner, workflow launch, `docker` helper |
| Standalone root tests | e.g. `src/inline-script-name.test.ts` | Small colocated cases that are not under a feature subtree |

When adding a new source module or extending an existing one, create or extend the corresponding `*.test.ts` in the same directory. For kernel internals, the compile path, and artifact contracts, see [Architecture](architecture.md).

### Integration tests

Tests that span multiple modules, require subprocess/PTY harnesses, or exercise process-level behavior live in `integration/`. These do not belong to a single module:

| Test file | Kind | What it covers |
|-----------|------|----------------|
| `integration/sample-build/build.test.ts` | Integration | Build/transpile behavior — `buildScripts`, `buildScriptFiles`, script extraction |
| `integration/sample-build/cli-tree.test.ts` | Integration | CLI tree output rendering for sample workflows |
| `integration/sample-build/run-core.test.ts` | Integration | Core runtime execution — workflow runs, step sequencing, artifacts |
| `integration/sample-build/run-prompt-agent.test.ts` | Integration | Prompt and agent interaction in sample workflows |
| `integration/sample-build/recover-handle.test.ts` | Integration | `recover` / `Handle<T>` async behavior in sample workflows |
| `integration/sample-build/test-advanced.test.ts` | Integration | Advanced test harness behavior — mocks, channels, edge cases |
| `integration/sample-build/test-framework.test.ts` | Integration | Test framework basics — `mock prompt`, `expect_*`, test block lifecycle |
| `integration/run-summary-jsonl.test.ts` | Integration | Runs the CLI on a small workflow and asserts structure and fields of `run_summary.jsonl` under `.jaiph/runs/` |
| `integration/signal-lifecycle.test.ts` | Acceptance | After SIGINT/SIGTERM, verifies `jaiph run` exits within a time bound and leaves no stale child processes |
| `integration/tty-running-timer.test.ts` | Acceptance | In a TTY, verifies the “RUNNING workflow” line updates over time (requires Python 3 PTY harness) |

The `integration/sample-build/` directory also has a shared `helpers.ts` module used by the sample-build tests. Shared test fixtures (`.jh` source files and expected output) live in `test-fixtures/sample-build/`.

## CI pipeline

The project uses GitHub Actions (`.github/workflows/ci.yml`). The workflow defines **six** jobs; on a typical feature-branch push, **five** of them run. The sixth — **Publish Docker runtime image** — runs only on pushes to **`nightly`** and on **`v*`** version tags, after the other jobs succeed. It builds and pushes `ghcr.io/jaiphlang/jaiph-runtime` (the default `runtime.docker_image` / `JAIPH_DOCKER_IMAGE` when Docker sandboxing is on; see **Docker runtime helper** in [Architecture](architecture.md#core-components)).

| Job | Runner | Purpose |
|-----|--------|---------|
| **ShellCheck** | `ubuntu-latest` | Runs `shellcheck` on `runtime/overlay-run.sh` to lint the standalone shell script shipped in the npm package. |
| **Compiler and unit tests** | `ubuntu-latest` | `npm test` (TypeScript unit + acceptance + golden tests), plus a `curl` check that the public install URL responds and a git-tag verification on `main`. |
| **E2E** | Matrix: **`ubuntu-latest` twice** + **`macos-latest`** | Job id `e2e`; in the Actions UI each leg appears as **`E2E (<os>, <label>)`**. Runs `npm run test:e2e`. The **`docker`** Ubuntu leg builds **`jaiph-ci-runtime:local`** from **`runtime/Dockerfile`** and exports **`JAIPH_DOCKER_IMAGE=jaiph-ci-runtime:local`** so scripts that set **`JAIPH_DOCKER_ENABLED=true`** do not pull **`ghcr.io/…`** during the job. **`JAIPH_UNSAFE`** is unset on that leg and set to **`true`** on Ubuntu **host** plus **macOS** — unlike manual **`jaiph run`** (see **`resolveDockerConfig`** / [Sandboxing](sandboxing.md)), that matrix choice does **not** mean “everything runs in Docker”: **`e2e/lib/common.sh`** sets **`JAIPH_DOCKER_ENABLED=false`** by default, so only scripts that explicitly re-enable Docker hit the sandbox. Container-only assertions on non-Linux runners use **`e2e::skip`** or availability guards. Implementation: **`src/runtime/docker.ts`**; overview: [Architecture — Core components](architecture.md#core-components). |
| **Getting started (local)** | `ubuntu-latest` | Serves the Jekyll site from `docs/` on `127.0.0.1:4000`, smoke-checks key routes with `curl`, builds the same local runtime image as E2E for any Docker-backed sample paths, installs Playwright (Chromium), and runs `npx playwright test` for landing-page samples. The Playwright step builds Jaiph, checks sample source against `examples/*.jh`, and runs deterministic samples through the CLI. No runtime dependency on `jaiph.org` for the site content. |
| **E2E install and CLI workflow (windows-latest + wsl)** | `windows-latest` | Provisions or selects a WSL distro, installs Node inside it, and runs `npm run test:e2e` under WSL with **`JAIPH_UNSAFE=true`**. |
| **Publish Docker runtime image** | `ubuntu-latest` | *Conditional (see above).* Multi-arch push to GHCR. |

### Version tags and npm

Pushing a **`v*`** ref does **not** run any npm publish step from this repository: the automation checked in under **`.github/workflows/`** is **`ci.yml`** (push CI) and **`nightly-engineer.yml`** (optional manual engineer run) — **neither publishes to npm**. The same tag pattern **does** satisfy the `if:` on the **`docker-publish`** job in **`ci.yml`**, which pushes `ghcr.io/jaiphlang/jaiph-runtime` after the other CI jobs succeed.

If you are preparing a release that includes the **npm** package, coordinate version bumps, registry publish, and smoke checks with the maintainers — that flow is intentionally outside this repo’s workflows.

### Local docs site (Jekyll)

The **Getting started (local)** CI job validates that the documentation site under `docs/` can be built and served from source. It uses Ruby 3.2 with `bundler-cache`, runs `bundle exec jekyll serve --host 127.0.0.1 --port 4000` in the background, and polls `http://127.0.0.1:4000/` for up to 30 seconds before asserting HTTP 200 on `/`, `/getting-started`, `/setup`, `/libraries`, and `/artifacts`. The same job also prepares Node, a local `jaiph-ci-runtime:local` image, Playwright Chromium, and (for samples that need them) external CLIs — see the `docs-local` job in `.github/workflows/ci.yml` for the exact package list, which can change.

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

After the Jekyll smoke-check, the CI job also verifies that code samples shown on the landing page match real CLI behavior. This uses Playwright (Chromium) with a test suite in `e2e/playwright/landing-page.spec.ts`.

The test does two things:

1. **Source parity** — extracts each sample's source code from the DOM (`[data-sample-source]` elements inside `[data-sample]` tab panels) and compares it byte-for-byte against the corresponding file in `examples/` (identified by `data-sample-file`).
2. **Output verification** — for each **`[data-sample-output]`** block whose sample/output key is **not** listed in **`SKIP_OUTPUT`** (`e2e/playwright/landing-page.spec.ts`), the test parses the **`➜`** command line, runs it against the temp copy of the page source (the executable **`.jh`** from **`examples/`** named by **`data-sample-file`**, with **`say_hello.test.jh`** also copying companion **`say_hello.jh`**), and compares normalized CLI output to the block. Normalization mirrors **`e2e::normalize_output`** (ANSI, durations, `<agent-command>` / `<script-path>`, log/summary/out/err path lines collapsed to `<path>`, spacing before **`✓ PASS`**). Entries in **`SKIP_OUTPUT`** mark nondeterministic model or agent-backed tabs (e.g. **`say-hello` / success**, **`async` / run**, **`recover-loop` / run**).

To run locally:

```bash
npm run test:samples
```

If a Jekyll server is already running on **`http://127.0.0.1:4000`**, Playwright reuses it (`reuseExistingServer` in `playwright.config.ts`). Otherwise it starts one.

Samples whose rendered output embeds nondeterministic model or agent transcripts skip output comparison per-tab via **`SKIP_OUTPUT`** in **`e2e/playwright/landing-page.spec.ts`** (see [Landing-page sample verification](#landing-page-sample-verification-playwright)); those tabs still participate in DOM **source parity**.

## E2E testing

The E2E test suite (`e2e/tests/*.sh`) drives the toolchain from outside the TypeScript harness: **`e2e::prepare_test_env`** (via **`prepare_shared_context`** in **`e2e/lib/common.sh`**) prepends a **`jaiph` shim** to **`PATH`** (preferring **`dist/src/cli.js`** when built), sanitizes stray **`JAIPH_*`** vars, wires **`JAIPH_REPO_URL`** to the cloned tree, exports **`JAIPH_DOCKER_ENABLED=false`** by default, then each script invokes **`jaiph run`**; Docker-specific assertions set **`JAIPH_DOCKER_ENABLED=true`** and expect **`JAIPH_DOCKER_IMAGE`** (for example **`jaiph-ci-runtime:local`** on the CI **`e2e`** **docker** matrix leg). Scripts assert on both the CLI tree (**`e2e::expect_stdout`**) and **`*.out` / `.err`** / **`run_summary.jsonl`** under **`.jaiph/runs/`** — see also [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

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

**Normalization:** `e2e::normalize_output` (in `e2e/lib/common.sh`) strips ANSI codes, replaces timing values with `<time>`, normalizes **`__inline_<hash>`** script names to **`__inline_<id>`**, swaps some CLI-specific strings (`<agent-command>`, `<script-path>`), and **sorts** a class of async progress lines (UTF-8 subscript markers) so strict equality stays stable when parallel branches finish in different orders. This keeps full-equality heredocs usable across machines.

**Where files land on disk** (directory tree, sequence prefixes): [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout). Runtime testing with `*.test.jh` is covered in [Testing](testing.md). The `run_summary.jsonl` event contract is exercised in `e2e/tests/88_run_summary_event_contract.sh`.

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
  const msg = run hello_impl()
  return "${msg}"
}
EOF

# When — run workflow (`jaiph` transpiles and executes inside the shim)
hello_out="$(e2e::run "hello.jh")"

# Then — assert on CLI tree output (include workflow return value when default() returns one)
e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
  ▸ script hello_impl
  ✓ script hello_impl (<time>)
✓ PASS workflow default (<time>)

hello-jh
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

After a workflow runs, its step outputs are written as sequenced artifact files under `.jaiph/runs/`. These helpers verify artifact content independently from CLI display output. For the on-disk layout and naming scheme, see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

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
| `e2e::assert_output_equals "$actual" "$expected" "label"` | Like **`assert_equals`**, but runs both strings through **`e2e::normalize_output`** first (ANSI, `<time>`, async line ordering — same normalization as **`expect_stdout`**). |
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
