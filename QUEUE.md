# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Cleanup — consolidate the 5-way test directory split #dev-ready

**Goal**
Today there are five different places that contain "tests": `src/**/*.test.ts` (60 unit tests, adjacent to source), `test/` (4 integration files totalling ~3347 LoC, including a 2814-LoC `sample-build.test.ts`), `tests/e2e-samples/` (one Playwright spec plus a shared `docs-site.ts` constants module), `compiler-tests/` (txtar fixtures), `golden-ast/` (fixtures + expected). Plus runners `src/compiler-test-runner.ts` and `src/golden-ast-runner.ts` mixed into the production source tree. A new contributor cannot tell where a new test belongs without reading the whole layout. Fix the structure in one pass.

**Context (read before starting)**

* The current `package.json` `test` script enumerates the test sources explicitly; this gives us a precise inventory of what is wired in:
  ```
  dist/test/*.test.js
  dist/src/**/*.test.js
  dist/src/**/*.acceptance.test.js
  dist/src/compiler-test-runner.js
  dist/src/golden-ast-runner.js
  ```
  Any move must update this script and keep the same test set running. Adding tests is out of scope; this is purely reorganization.
* `src/compiler-test-runner.ts` and `src/golden-ast-runner.ts` are compiled and shipped in `dist/`, but they are test infrastructure (they consume fixtures, produce assertions). They should not live in `src/`.
* `compiler-tests/README.md` already documents the txtar format — preserve that doc next to the fixtures it describes.

**Scope**

* **Move test infrastructure out of `src/`**:
  - `src/compiler-test-runner.ts` → `test-infra/compiler-test-runner.ts`
  - `src/golden-ast-runner.ts` → `test-infra/golden-ast-runner.ts`
  - `tsconfig.json` and `package.json` `test` script updated to reference the new locations.
* **Rename and group fixture directories**:
  - `compiler-tests/` → `test-fixtures/compiler-txtar/` (preserves the README inside).
  - `golden-ast/` → `test-fixtures/golden-ast/` (preserves the `fixtures/` and `expected/` subdirs underneath).
  - Update path references in `test-infra/compiler-test-runner.ts` and `test-infra/golden-ast-runner.ts`.
* **Fold the Playwright spec**:
  - `tests/e2e-samples/landing-page.spec.ts` → `e2e/playwright/landing-page.spec.ts`.
  - `tests/e2e-samples/docs-site.ts` (the shared constants module imported by the spec) → `e2e/playwright/docs-site.ts`. Update the relative import.
  - Update `playwright.config.ts` and the `test:samples` npm script accordingly.
  - Delete the now-empty `tests/` directory.
* **Triage `test/` (4 files, ~3347 LoC)**:
  - `test/run-summary-jsonl.test.ts` (178 LoC), `test/signal-lifecycle.test.ts` (220 LoC), `test/tty-running-timer.test.ts` (135 LoC) — keep in a renamed `integration/` directory. They are integration-flavored, not unit, and don't have an obvious adjacent home.
  - `test/sample-build.test.ts` (2814 LoC) — split. Read the file, group its tests by which subsystem they actually exercise, and move each group either next to that subsystem (`src/.../<name>.integration.test.ts`) or into `integration/sample-build/<topic>.test.ts`. Aim for no resulting file over ~600 LoC. The split is the work; it is not optional.
  - Move `test/expected/` and `test/fixtures/` to `test-fixtures/sample-build/` if any test still references them after the split.
* **Final layout** (target):
  ```
  src/**/*.test.ts                       # unit, adjacent (unchanged)
  src/**/*.acceptance.test.ts            # acceptance, adjacent (unchanged)
  integration/**/*.test.ts               # integration tests (was `test/`, after split)
  test-fixtures/compiler-txtar/          # was `compiler-tests/`
  test-fixtures/golden-ast/              # was `golden-ast/`
  test-fixtures/sample-build/            # if any sample-build fixtures survive the split
  test-infra/compiler-test-runner.ts     # was `src/compiler-test-runner.ts`
  test-infra/golden-ast-runner.ts        # was `src/golden-ast-runner.ts`
  e2e/                                   # shell + .jh (unchanged)
  e2e/playwright/landing-page.spec.ts    # was `tests/e2e-samples/`
  ```
  Three test "places" instead of five (`src/`-adjacent, `integration/`, `e2e/`); plus two clearly named support directories (`test-fixtures/`, `test-infra/`).
* Update `package.json` `test`, `test:compiler`, `test:golden-ast`, `test:samples`, `test:acceptance`, `test:ci`, `test:e2e` scripts to reference the new paths. Verify by running `npm test` end-to-end.

**Non-goals**

* Do not change any test's logic, assertions, or fixtures' contents. The goal is layout, not behavior.
* Do not change the unit-tests-adjacent-to-source convention. That part works.
* Do not delete any test (other than ones absorbed into the `sample-build.test.ts` split, where the original file goes away after redistribution).

**Acceptance criteria**

* `npm test` passes with the same test count (or higher, if the `sample-build` split surfaces previously-bundled cases as separate tests). Test count must not decrease.
* No file in `src/` is named `*-test-runner.ts`. Test infrastructure lives only in `test-infra/`.
* No file under `integration/` exceeds ~600 LoC after the `sample-build` split.
* The repo root no longer has both `test/` and `tests/`. (`tests/` is deleted after folding.)
* `package.json` test scripts reference the new paths and the same test set runs in CI.
* Commit message documents the file-move map (old → new) so reviewers can sanity-check that nothing was lost.

***

## Language cleanup — drop `JAIPH_INBOX_PARALLEL` parallel inbox dispatch #dev-ready

**Goal**
Remove the opt-in parallel-mode for inbox dispatch. Always drain the inbox queue sequentially. The "parallel" mode (`JAIPH_INBOX_PARALLEL=true` env var or `run.inbox_parallel = true` config key) uses `Promise.all` over routed targets within a single Node process — which gives no real CPU parallelism, only I/O interleaving for prompt-heavy receivers, while paying ongoing taxes (the `JAIPH_INBOX_PARALLEL_LOCKED` env shim, the `inbox_parallel` config key, the `docs/inbox.md` non-determinism caveats, and the more complex `drainWorkflowQueue` logic).

**Context (read before starting)**

* The parallel branch is in `src/runtime/kernel/node-workflow-runtime.ts:1316` (`const parallel = scope.env.JAIPH_INBOX_PARALLEL === "true";`) and the env-propagation logic at `:1779–1781` (`applyMetadataScope`).
* The CLI sets the env var from config in `src/cli/run/env.ts:64–66` and locks it in `LOCKED_ENV_KEYS:13`.
* The config key `run.inbox_parallel` lives in `src/parse/metadata.ts`: `ALLOWED_KEYS:13`, `KEY_TYPES:33`, `KEY_SETTERS:149`. `WorkflowMetadata.run.inboxParallel` is the AST field.
* User-visible doc references: `docs/inbox.md` (look for "JAIPH_INBOX_PARALLEL" and "parallel" — the non-determinism caveat section).
* E2E coverage: `e2e/tests/91_inbox_dispatch.sh` has a "Parallel dispatch via JAIPH_INBOX_PARALLEL env var" scenario at the bottom. This entire scenario is dropped along with the feature.

**Scope**

* **Runtime**:
  - In `drainWorkflowQueue` (`node-workflow-runtime.ts:1316`), remove the `parallel` branch entirely. Sequential drain only.
  - In `applyMetadataScope` (`:1779`), remove the `JAIPH_INBOX_PARALLEL` propagation block.
* **CLI env** (`src/cli/run/env.ts`):
  - Remove `JAIPH_INBOX_PARALLEL` from `LOCKED_ENV_KEYS`.
  - Remove the `inboxParallel`-from-config block at lines 64–66.
* **Config schema** (`src/parse/metadata.ts`):
  - Remove `"run.inbox_parallel"` from `ALLOWED_KEYS`, `KEY_TYPES`, and `KEY_SETTERS`.
  - `run.inbox_parallel = …` in a config block now produces `unknown config key: run.inbox_parallel`. (Free of charge from the existing `unknown config key` error path.)
* **AST types** (`src/types.ts`):
  - Remove `inboxParallel?: boolean` from `WorkflowMetadata.run`.
* **Docs** (`docs/inbox.md`):
  - Remove the `JAIPH_INBOX_PARALLEL` paragraph and the non-determinism caveats. State explicitly that inbox dispatch is sequential.
* **E2E** (`e2e/tests/91_inbox_dispatch.sh`):
  - Delete the "Parallel dispatch via JAIPH_INBOX_PARALLEL env var" scenario. Keep the rest of the file (sequential-mode tests).

**Non-goals**

* Do not change channel/route semantics or the inbox queue persistence (the per-message file write under `inbox/` when routed). That stays as-is.
* Do not touch `INBOX_ENQUEUE` / `INBOX_DISPATCH_START` / `INBOX_DISPATCH_COMPLETE` event shapes in `run_summary.jsonl`.
* Do not introduce a new opt-in for parallel dispatch under a different name. The point is removal.

**Acceptance criteria**

* `JAIPH_INBOX_PARALLEL=true` has no effect on `drainWorkflowQueue` (verifiable by adding a unit test that runs with and without the env var and asserts identical sequencing of dispatch events).
* `run.inbox_parallel = true` in a `config { … }` block produces `E_PARSE: unknown config key: run.inbox_parallel`. A unit test in `src/parse/parse-metadata.test.ts` covers this.
* `WorkflowMetadata.run` no longer has the `inboxParallel` field.
* `docs/inbox.md` no longer mentions `JAIPH_INBOX_PARALLEL` or non-determinism caveats; it states sequential dispatch.
* `bash e2e/test_all.sh` passes with the parallel-mode scenario removed.
* `npm test` passes.

***

## Refactor — split `src/runtime/kernel/node-workflow-runtime.ts` (1915 LoC) #dev-ready

**Goal**
`src/runtime/kernel/node-workflow-runtime.ts` is a 1915-LoC god file: ~280 LoC of free arg-parsing helpers above the class, then ~1620 LoC of `NodeWorkflowRuntime` spanning workflow orchestration, step execution, prompt step lifecycle, event emission, mock execution, frame stack management, and heartbeat I/O. Reading or modifying any one concern requires holding all of them in head. Split along clean seams so each concern is in a focused module.

**Context (read before starting)**

* This file is actively touched by the `Handle<T>` task. If that task is in flight, **rebase on it before splitting** — do not do this work in parallel without coordinating, or the merge will be miserable.
* The class has stateful internals (`runId`, `runDir`, `summaryFile`, `heartbeatTimer`, `frameStack`, `asyncIndices`, `env`, `cwd`, `graph`, `mockBodies`). The split must keep state in the class and move stateless helpers out, or pass state explicitly into the extracted modules. Do not invent a second source of truth.
* Free helpers above the class (`interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH`, `sanitizeName`, `nowIso`) — all stateless. Safe to extract.
* Methods that are pure event emission (`emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`) all call `appendRunSummaryLine` and `process.stderr.write`. They depend on the class only for `runId`, `summaryFile`, and `getAsyncIndices()`. Can move to a module that takes those as constructor args.
* Mock execution methods (`executeMockBodyDef`, `executeMockShellBody`) are largely self-contained and could move to a sibling module.
* The runtime now also contains two helpers added during the recent audit refactor: `runRecoverBody` (catch/recover body executor) and `runPromptStep` (shared prompt-step pipeline). Both depend on `executeSteps` / `interpolateWithCaptures` and stay with the orchestrator class.
* `src/runtime/kernel/run-step-exec.ts` was deleted in the audit cleanup; ignore any prior reference to it as a "do not touch" file.

**Scope**

Extract three new sibling modules under `src/runtime/kernel/`:

* **`runtime-arg-parser.ts`** — every stateless free helper currently above the `NodeWorkflowRuntime` class:
  - `interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `sanitizeName`, `nowIso`
  - The `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH` constants
  - The `ParsedArgToken`, `PromptSchemaField` types if they are not used elsewhere in the class
  - **Required**: extracted helpers must have unit tests (some already do indirectly via runtime tests; new direct tests live in `runtime-arg-parser.test.ts`).
* **`runtime-event-emitter.ts`** — a small class `RuntimeEventEmitter` constructed with `{ runId, asyncIndicesGetter, env }`, exposing `emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`. The runtime constructs one and delegates. No more direct `process.stderr.write(__JAIPH_EVENT__ ...)` scattered through the runtime.
* **`runtime-mock.ts`** — `executeMockBodyDef` and `executeMockShellBody` move here as exported functions taking `{ ref, args, env, cwd, executeStepsBack }` (the last is a callback so the mock can dispatch back into the runtime for `kind: "steps"` mocks). Removes the `require("node:child_process")` call that currently shadows ESM imports inside `executeMockShellBody` — that is a code smell that should die in this task.

After the split, `node-workflow-runtime.ts` keeps only:
* The `NodeWorkflowRuntime` class
* Workflow/step orchestration (`runDefault`, `runNamedWorkflow`, `executeSteps`, `executeStep`, frame and scope management, `runRecoverBody`, `runPromptStep`)
* The async-handle bookkeeping (`getAsyncIndices`, `getFrameStack`)
* Heartbeat (`startHeartbeat`, `stopHeartbeat`, `writeHeartbeat`)

Target size for `node-workflow-runtime.ts` after split: ~1000–1200 LoC. Still large, but a single coherent concern (the orchestrator).

**Non-goals**

* Do not change behavior. Every existing test must still pass without modification.
* Do not redesign the event format, the mock contract, or the arg-parser's accepted syntax. This is a relocation task only.
* Do not split further than the three new modules listed. Over-decomposition is its own problem; this task is calibrated for one round of splitting.
* Do not touch `node-workflow-runner.ts` (the CLI shim) — it is correctly sized and out of scope.

**Acceptance criteria**

* `src/runtime/kernel/node-workflow-runtime.ts` is between 1000 and 1200 LoC after the split.
* `src/runtime/kernel/runtime-arg-parser.ts`, `runtime-event-emitter.ts`, `runtime-mock.ts` exist and own their respective concerns.
* `runtime-arg-parser.test.ts` exists with direct unit tests for the extracted helpers.
* `npm test` passes with no test changes other than possibly importing helpers from their new location.
* No `require("node:...")` calls inside class methods (they are replaced by top-of-file `import` statements as part of the mock extraction).
* The new modules have no circular imports back into `node-workflow-runtime.ts`. Dependency direction is one-way: orchestrator → helpers/emitter/mock.

***

## Cleanup — remove `JAIPH_TEST_MODE` event suppression in production runtime code #dev-ready

**Goal**
The runtime currently checks `this.env.JAIPH_TEST_MODE !== "1"` at two sites in `node-workflow-runtime.ts` (lines 649 and 1872, in the `emitLog` and `emitStep` methods after the runtime split moves them into `runtime-event-emitter.ts`) before writing `__JAIPH_EVENT__` lines to stderr. This is a test-only conditional embedded in production code: tests that construct `NodeWorkflowRuntime` in-process set `JAIPH_TEST_MODE=1` to keep their stderr clean. Replace it with an explicit construction-time switch so production code has no test-mode awareness.

**Context (read before starting)**

* If the runtime split has landed, the two `JAIPH_TEST_MODE` checks now live in `runtime-event-emitter.ts`. If not yet, they are at `node-workflow-runtime.ts:649` and `:1872`. This task should be done **after** the runtime split — the new event-emitter module is the natural home for the construction-time switch.
* `JAIPH_TEST_MODE` is also read by `prompt.ts` (line 85, `isTestMode`) for selecting mock dispatch over the real backend. **That use is legitimate** and not in scope for this task. We are removing only the event-suppression use.
* `node-test-runner.ts` sets `JAIPH_TEST_MODE: "1"` at line 149 when building the env for in-process runtime construction. After this task, that env var still belongs there for `prompt.ts`'s benefit, but should no longer affect event emission.
* The reason this can't simply be deleted: `node-test-runner.ts` runs `NodeWorkflowRuntime` in the same Node process as the test runner. Without suppression, every workflow event (`STEP_START`, `STEP_END`, `LOG`, etc.) would print to the test process's stderr, swamping `node --test` reporter output.

**Scope**

* **Constructor option** (`src/runtime/kernel/runtime-event-emitter.ts` after split, or `node-workflow-runtime.ts` if before):
  - Add a `suppressLiveEvents?: boolean` option to the `RuntimeEventEmitter` constructor (or `NodeWorkflowRuntimeOptions`).
  - Replace `if (this.env.JAIPH_TEST_MODE !== "1")` with `if (!this.suppressLiveEvents)`. The check moves from a per-call env read to a constructor-time property.
* **Test runner** (`src/runtime/kernel/node-test-runner.ts`):
  - When constructing `NodeWorkflowRuntime` for a `test_run_workflow` step, pass `suppressLiveEvents: true` in the options.
  - Keep `JAIPH_TEST_MODE: "1"` in the env (for `prompt.ts`'s mock-mode selection).
* **Production paths**:
  - `node-workflow-runner.ts` (the CLI's spawned child) constructs the runtime without the option, so `suppressLiveEvents` defaults to `false` and live events stream to stderr as before.
  - No other production caller constructs `NodeWorkflowRuntime` directly.

**Non-goals**

* Do not remove `JAIPH_TEST_MODE` reads from `prompt.ts`. The mock-mode selection use is legitimate and not in scope.
* Do not change the `__JAIPH_EVENT__` format, the durable `appendRunSummaryLine` call, or any other runtime behavior. This task moves a single conditional from a runtime env read to a constructor option.
* Do not introduce a new env var for the suppression. The whole point is to take the env-var conditional out of production code.

**Acceptance criteria**

* No production code in `src/runtime/kernel/` (excluding `prompt.ts`'s mock-mode selection) reads `JAIPH_TEST_MODE` for any purpose.
* `NodeWorkflowRuntime` (or `RuntimeEventEmitter`) has a documented `suppressLiveEvents` option.
* In-process tests pass `suppressLiveEvents: true` and continue to produce clean test output.
* `npm test` passes; running it does **not** print any `__JAIPH_EVENT__` lines to stderr (modulo the e2e shell tests which exercise the production CLI path).
* Spawning `node-workflow-runner.js` directly (production path, e.g. via `jaiph run`) still emits `__JAIPH_EVENT__` lines on stderr as before — verified by an existing e2e test or a new acceptance test.

***

## Performance — investigate and fix slow installation

**Goal**
`jaiph install` (and related dependency or bootstrap steps) feels unreasonably slow; find the dominant cost and improve it without weakening reproducibility (lockfile, shallow clone behavior, etc.).

**Scope**

* Profile or instrument the install path (git clone, lockfile I/O, post-install) and document the top 1–3 contributors to latency.
* Implement targeted fixes (e.g. avoid redundant work, reduce subprocess churn, cache safely) and verify wall-clock improvement on a cold and warm run where applicable.

**Acceptance criteria**

* A short note in the commit or PR description states what was slow and what changed, with before/after rough timings on the same machine.
* `jaiph install` behavior remains correct: same lockfile semantics and failure modes for bad URLs or missing refs.
* `npm test` passes.

***

## Performance — investigate and fix slow workflow start (initial 2–4 s lag)

**Goal**
When starting workflows (e.g. `jaiph run` / first step), users observe a 2–4 second delay before useful work; reduce that lag or explain and eliminate unnecessary startup work (JIT, imports, process spawn, discovery).

**Scope**

* Reproduce the lag with a minimal `.jh` workflow; trace Node startup, module load, and runtime init (`NodeWorkflowRuntime` and friends).
* Address fixable costs (e.g. defer heavy work, lazy imports, avoid redundant file scans) without changing user-visible workflow semantics.

**Acceptance criteria**

* Documented repro (command + minimal file) and what was measured (time to first event / first step).
* Measurable reduction in the cold-start path on a representative case, or a clear justification if the lag is irreducible (e.g. external subprocess).
* `npm test` passes.

***
