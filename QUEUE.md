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

## Artifacts — runtime mount + `artifacts.jh` lib for publishing files out of the sandbox #dev-ready

**Goal**
Give workflows a clean, versatile way to publish files from inside the whole-program Docker sandbox to a host-readable location. Split the work across two layers:

* **Runtime layer** (in `src/runtime/`): expose a writable artifacts directory inside the sandbox at a stable path, mapped to `.jaiph/runs/<run_id>/artifacts/` on the host. No new language primitive; the runtime's only job is to mount and to surface the path via env var.
* **Library layer** (in `.jaiph/libs/jaiphlang/`): ship a new `artifacts.jh` lib (mirroring the existing `queue.jh` / `queue.py` pair) with `export workflow` entries for the common operations. Userspace imports the lib explicitly:

  ```jh
  import "jaiphlang/artifacts.jh" as artifacts

  workflow default() {
    run artifacts.save("./build/output.bin", "build-output.bin")
    run artifacts.save_patch("snapshot.patch")
  }
  ```

This keeps the runtime minimal (just a mount), makes the surface library-shaped (so it's discoverable and replaceable), and matches the established `queue.jh` pattern.

**Context (read before starting)**

* Today's whole-program Docker sandbox in `src/runtime/docker.ts` already mounts the run directory writable at `/jaiph/run`. Artifacts will live in a subdirectory of that mount; no new mount is needed.
* The existing lib pattern is `.jaiph/libs/jaiphlang/queue.jh` paired with `.jaiph/libs/jaiphlang/queue.py` (a small Python helper invoked via `import script ... as queue`). Follow that pattern.
* The `isolated` keyword is not part of this codebase. This task is about the whole-program Docker sandbox only; no per-call isolation primitive exists or is to be introduced.

**Scope**

**Runtime layer:**

* Ensure `.jaiph/runs/<run_id>/artifacts/` exists on the host before the sandbox starts (`mkdirSync` with `recursive: true`).
* The existing `/jaiph/run` mount in the container already exposes the artifacts subdirectory implicitly. Verify it does, and that writes inside the container land at `.jaiph/runs/<run_id>/artifacts/` on the host.
* Surface the in-container artifacts path to userspace via an env var. Suggested name: `JAIPH_ARTIFACTS_DIR` (defaulting to `/jaiph/run/artifacts` in the container, `<host_run_dir>/artifacts` on the host when running without the sandbox). The library reads this env var rather than hardcoding the path.
* When running on the host (no sandbox), `JAIPH_ARTIFACTS_DIR` points at the host artifacts directory directly so the same lib works.

**Library layer:**

* Add `.jaiph/libs/jaiphlang/artifacts.jh` and `.jaiph/libs/jaiphlang/artifacts.py` (or `.sh` if it stays a one-liner). Mirror the `queue.jh` / `queue.py` shape exactly — no novel patterns.
* Provide these `export workflow` entries:
  - `save(local_path, name)` — copies the file at `local_path` into `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the host-resolved absolute path as a string.
  - `save_patch(name)` — runs `git diff` (working tree vs HEAD) inside the sandbox workspace, writes it to `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the host-resolved absolute path.
  - `apply_patch(path)` — applies a patch file to the current workspace via `git apply`. Useful for replaying artifacts across runs.
* The lib must work both inside the sandbox and on the host (when the user runs `jaiph` without the Docker sandbox). The only difference is what `JAIPH_ARTIFACTS_DIR` resolves to.
* Document that `save_patch` excludes `.jaiph/` from the produced patch (the runtime writes its own state under `.jaiph/`; including it in a patch would clobber state on apply). The exclusion lives in the lib's helper script, not in the runtime, and is documented inline next to the implementation.

**Required tests**

* **Runtime tests**:
  - `JAIPH_ARTIFACTS_DIR` is set inside the sandbox and points at a writable directory.
  - `JAIPH_ARTIFACTS_DIR` is set when running on the host (no sandbox) and points at `.jaiph/runs/<run_id>/artifacts/`.
  - The artifacts directory exists before the sandbox starts (no race where the lib tries to write before the dir exists).
* **Library tests**:
  - `artifacts.save(local_path, name)`: file is created at the host path; return value matches that path; file content equals the source.
  - `artifacts.save_patch(name)`: produces a non-empty patch when the workspace has uncommitted changes; produces an empty (or absent) patch when the workspace is clean; the patch does not reference `.jaiph/` even when `.jaiph/` files have changed.
  - `artifacts.apply_patch(path)`: applies a previously-saved patch cleanly; fails with a clear error when the patch does not apply.
* **End-to-end**:
  - One `.jh` example workflow that imports `jaiphlang/artifacts.jh`, calls `artifacts.save` and `artifacts.save_patch`, runs under the sandbox, and the test asserts both files appear on the host at the expected paths.

**Acceptance criteria**

* `.jaiph/runs/<run_id>/artifacts/` exists, is writable from inside the sandbox, and survives sandbox teardown (it's on the host filesystem via the existing mount).
* `JAIPH_ARTIFACTS_DIR` is exposed in both sandbox and host execution; the lib reads it rather than hardcoding paths.
* `.jaiph/libs/jaiphlang/artifacts.jh` ships with `save`, `save_patch`, `apply_patch` as `export workflow` entries, mirroring the `queue.jh` lib shape.
* The lib works identically inside the sandbox and on the host.
* `save_patch`'s `.jaiph/` exclusion is documented inline in the helper script.
* No new runtime language primitive is introduced. The user-facing surface is `import` + workflow calls.
* The docs-site documentation is updated to describe the artifacts lib alongside the queue lib (`docs/libraries.md` or equivalent).

***

## Runtime — PTY-based TTY test for `run async` #dev-ready

**Goal**
Live progress for `run async` (with handles, deferred resolution, multi-branch fan-out without isolation) takes a different render path than synchronous steps. Close the regression-coverage gap by exercising that path through a real PTY.

**Context (read before starting)**

`e2e/tests/81_tty_progress_tree.sh` already uses Python's `pty.openpty()` to drive `jaiph run` under a real TTY and asserts on the rendered progress frames. It covers non-async workflows. There is no equivalent for `run async`. The host progress renderer takes a different path for async (handles, deferred resolution, multiple in-flight calls competing for the live frame), and that path has been broken before without any test catching it.

**Scope**

* Add an e2e test (sibling of `e2e/tests/81_tty_progress_tree.sh`) that:
  * spawns `jaiph run` under a real PTY,
  * exercises a workflow that uses `run async branch()` with at least two concurrent async calls,
  * each branch emits multiple progress events over time (use a deterministic step like a sleep loop with `print` calls — do not depend on `prompt claude` or any other non-deterministic step),
  * captures the PTY output and asserts:
    1. each branch's progress events appear under that branch's node in the tree as they happen,
    2. the final frame shows both branches as completed with their resolved return values,
    3. no ANSI corruption (orphaned escape sequences, stray cursor moves outside the rendered region).
* The test must fail today against any regression that batches async progress events at branch completion, drops them, or scrambles the frame.

**Non-goals**

* Do not test `prompt claude` or any non-deterministic step. Branches must emit synthetic, time-spaced events.
* Do not assert on exact frame timing; assert on order and presence within a generous timeout.
* No `isolated` variant — that keyword is not part of this codebase.

**Acceptance criteria**

* New test lives next to `e2e/tests/81_tty_progress_tree.sh` and follows the same shell-driving-Python-PTY pattern.
* The test passes on a green build and fails when the live-progress path for `run async` regresses.
* Test runs as part of the standard e2e suite (no separate invocation).

***

## Cleanup — delete top-level debug cruft and harden `.gitignore` #dev-ready

**Goal**
The repo root contains 22+ leftover debug directories from an abandoned per-call isolated experiment (`docker-nested-arg.*`, `docker-nested-clean.*`, `overlay-warn.*`, `nested-run-arg.*`, `local-nested-arg.*`, `overlay-manual.*`, `docker-live-debug.*`), plus stale `.tmp`, `.tmp-build`, `.tmp-debug`, `.tmp_run_debug`, `QUEUE.md.tmp.4951`, `safe_name`, top-level `lib/`, top-level `run/`. None are in `.gitignore`. Fix that, in one pass, so the workspace is readable at a glance and these don't return.

**Scope**

* Delete every leftover debug directory at the repo root matching `docker-*/`, `nested-*/`, `overlay-*/`, `local-*/`, `.tmp*/`. Verify with `git ls-files <pattern>` first that they are not tracked (they should not be).
* Investigate three suspicious top-level paths: `safe_name`, `lib/`, `run/`. The default disposition is **delete**. Only keep one if you can identify a live consumer in the source tree (search with `rg`/`grep` for the path string). If a consumer exists, document it inline next to the deletion decision.
* Delete tracked cruft files: `safe_name` and `QUEUE.md.tmp.4951`. Verify they are tracked first (`git ls-files`); use `git rm` rather than `rm` for tracked paths.
* Add patterns to `.gitignore` so they cannot return without a deliberate override:
  - `docker-*/`
  - `nested-*/`
  - `overlay-*/`
  - `local-*/`
  - `.tmp*/`
  - `QUEUE.md.tmp.*`
* Sanity-check: after the cleanup, `ls` at the repo root should show only documented project directories. No `.cidfile`, no `.pid`, no random temp dir names.

**Non-goals**

* Do not touch `.jaiph/runs/`, `dist/`, `node_modules/` — already in `.gitignore` and load-bearing.
* Do not delete the `docker/` directory (singular, no suffix) — that is a different, intentional location.
* No code changes; this task is filesystem hygiene only.

**Acceptance criteria**

* Repo root listing contains zero `docker-*`, `nested-*`, `overlay-*`, `local-*`, or `.tmp*` directories after the change.
* `.gitignore` contains the patterns listed above; `git status` is clean immediately after deletion.
* Disposition of `safe_name`, `lib/`, `run/` is recorded in the commit message (deleted, kept-and-why).
* A second `npm run build && npm test` after the cleanup passes (proves nothing important was removed).

***

## Cleanup — remove dead per-call-isolated leftovers from `src/runtime/docker.ts` #dev-ready

**Goal**
`src/runtime/docker.ts` (688 LoC) still exports four functions written exclusively for the now-abandoned per-call `isolated` keyword: `exportWorkspacePatch`, `findRunArtifacts`, plus the helper `exportPatchIfDocker` in `src/runtime/kernel/node-workflow-runtime.ts`. These have one or two live callers each, all of which are themselves transitional code from the same abandoned design. Once the new `artifacts.jh` lib has landed (it replaces the use case end-to-end), these can go. Net reduction: ~200 LoC of source + ~150 LoC of dead tests in `src/runtime/docker.test.ts`.

**Context (read before starting)**

* `exportWorkspacePatch(workspaceDir, outputPath)` writes a `git diff` patch when running inside the Docker sandbox. Single live caller: `NodeWorkflowRuntime.exportPatchIfDocker()` (in `src/runtime/kernel/node-workflow-runtime.ts`), which writes `<runDir>/workspace.patch` at workflow end. The new `artifacts.save_patch()` workflow in `.jaiph/libs/jaiphlang/artifacts.jh` (shipped by the artifacts task) replaces this use case explicitly: callers who want a patch ask for one by name, with the path returned to them.
* `findRunArtifacts(sandboxRunDir)` discovers the latest run dir under a Docker-mounted artifacts area. Single live caller: `src/cli/commands/run.ts:367` — the host reads it after the sandbox exits to surface the inner run's artifacts. With the artifacts task's explicit `JAIPH_ARTIFACTS_DIR` mount and known path, this discovery is no longer needed: the host already knows where to look.
* The `isolated` keyword is not part of this codebase. There is no per-call isolation primitive to keep these helpers alive for.

**Scope**

* **Precondition check**: before deleting, run `rg 'exportWorkspacePatch|findRunArtifacts|exportPatchIfDocker' src/` and verify the only callers are the ones listed above. If any new caller has appeared, evaluate it on the spot — either it is also dead and can go in this task, or removal is blocked and you stop and report.
* **Precondition check**: confirm the artifacts task has shipped (look for `.jaiph/libs/jaiphlang/artifacts.jh` and a working `artifacts.save_patch`). If it has not, this task is not ready — do not attempt half-removal that breaks the runtime.
* Remove from `src/runtime/docker.ts`:
  - `exportWorkspacePatch` (function + export)
  - `findRunArtifacts` (function + export)
* Remove from `src/runtime/kernel/node-workflow-runtime.ts`:
  - `exportPatchIfDocker` (private method)
  - The import of `exportWorkspacePatch` from `../docker`
  - Any call site of `exportPatchIfDocker` (verify zero remain after the method is gone)
* Remove from `src/cli/commands/run.ts`:
  - The `findRunArtifacts(sandboxRunDir)` call at line ~367
  - The import of `findRunArtifacts`
  - Any code that consumes the result of `findRunArtifacts` and is now dead (chase the value, do not leave dangling variables)
* Remove from `src/runtime/docker.test.ts`:
  - All `findRunArtifacts: ...` test cases
  - All `exportWorkspacePatch: ...` test cases
  - The shared test fixtures used only by those tests

**Non-goals**

* Do not touch `writeOverlayScript`, `overlayMountPath`, `buildDockerArgs`, or other docker.ts functions — those remain load-bearing for the whole-program Docker sandbox.
* Do not modify the artifacts lib or its runtime mount; this task only removes the predecessor primitives.
* Do not collapse env vars or config keys — that is a separate concern explicitly out of scope.

**Acceptance criteria**

* `rg 'exportWorkspacePatch|findRunArtifacts|exportPatchIfDocker' src/` returns zero matches.
* `npm run build` succeeds with no TypeScript errors after removal.
* `npm test` passes (proves no remaining test depends on the deleted primitives).
* Net diff: ~200 LoC removed from `src/runtime/docker.ts` and `src/runtime/kernel/node-workflow-runtime.ts`, ~150 LoC of dead tests removed from `src/runtime/docker.test.ts`. If your diff is materially smaller, you missed something; if materially larger, you are deleting more than the task scope — stop and reassess.

***

## Cleanup — consolidate the 5-way test directory split #dev-ready

**Goal**
Today there are five different places that contain "tests": `src/**/*.test.ts` (66 unit tests, adjacent to source), `test/` (4 integration files including a 2427-LoC `sample-build.test.ts`), `tests/e2e-samples/` (a single Playwright file), `compiler-tests/` (txtar fixtures), `golden-ast/` (fixtures + expected). Plus runners `src/compiler-test-runner.ts` and `src/golden-ast-runner.ts` mixed into the production source tree. A new contributor cannot tell where a new test belongs without reading the whole layout. Fix the structure in one pass.

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
* **Fold the singleton Playwright test**:
  - `tests/e2e-samples/landing-page.spec.ts` → `e2e/playwright/landing-page.spec.ts`.
  - Update `playwright.config.ts` and the `test:samples` npm script accordingly.
  - Delete the now-empty `tests/` directory.
* **Triage `test/` (4 files, 2960 LoC)**:
  - `test/run-summary-jsonl.test.ts` (178 LoC), `test/signal-lifecycle.test.ts` (220 LoC), `test/tty-running-timer.test.ts` (135 LoC) — keep in a renamed `integration/` directory. They are integration-flavored, not unit, and don't have an obvious adjacent home.
  - `test/sample-build.test.ts` (2427 LoC) — split. Read the file, group its tests by which subsystem they actually exercise, and move each group either next to that subsystem (`src/.../<name>.integration.test.ts`) or into `integration/sample-build/<topic>.test.ts`. Aim for no resulting file over ~600 LoC. The split is the work; it is not optional.
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

## Refactor — split `src/runtime/kernel/node-workflow-runtime.ts` (1720 LoC) #dev-ready

**Goal**
`src/runtime/kernel/node-workflow-runtime.ts` is a 1720-LoC god file: ~280 LoC of free arg-parsing helpers above the class, then a 1440-LoC `NodeWorkflowRuntime` class with 25 methods spanning workflow orchestration, step execution, prompt step lifecycle, event emission, mock execution, frame stack management, and heartbeat I/O. Reading or modifying any one concern requires holding all of them in head. Split along clean seams so each concern is in a focused module.

**Context (read before starting)**

* This file is actively touched by the `Handle<T>` task. If that task is in flight, **rebase on it before splitting** — do not do this work in parallel without coordinating, or the merge will be miserable.
* The class has stateful internals (`runId`, `runDir`, `summaryFile`, `heartbeatTimer`, `frameStack`, `asyncIndices`, `env`, `cwd`, `graph`, `mockBodies`). The split must keep state in the class and move stateless helpers out, or pass state explicitly into the extracted modules. Do not invent a second source of truth.
* Free helpers above the class (`interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH`, `sanitizeName`, `nowIso`) — all stateless. Safe to extract.
* Methods that are pure event emission (`emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`) all call `appendRunSummaryLine` and `process.stderr.write`. They depend on the class only for `runId`, `summaryFile`, and `getAsyncIndices()`. Can move to a module that takes those as constructor args.
* Mock execution methods (`executeMockBodyDef`, `executeMockShellBody`) are largely self-contained and could move to a sibling module.

**Scope**

Extract three new sibling modules under `src/runtime/kernel/`:

* **`runtime-arg-parser.ts`** — every stateless free helper currently above the `NodeWorkflowRuntime` class:
  - `interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `sanitizeName`, `nowIso`
  - The `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH` constants
  - The `ParsedArgToken`, `PromptSchemaField` types if they are not used elsewhere in the class
  - **Required**: extracted helpers must have unit tests (some already do indirectly via runtime tests; new direct tests live in `runtime-arg-parser.test.ts`).
* **`runtime-event-emitter.ts`** — a small class `RuntimeEventEmitter` constructed with `{ runId, asyncIndicesGetter, env }`, exposing `emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`. The runtime constructs one and delegates. No more direct `process.stderr.write(__JAIPH_EVENT__ ...)` scattered through the runtime.
* **`runtime-mock.ts`** — `executeMockBodyDef` and `executeMockShellBody` move here as exported functions taking `{ ref, args, env, cwd, executeStepsBack }` (the last is a callback so the mock can dispatch back into the runtime for `kind: "steps"` mocks). Removes the `require("node:child_process")` and `require("node:fs")` calls that currently shadow ESM imports inside the class body — that is a code smell that should die in this task.

After the split, `node-workflow-runtime.ts` keeps only:
* The `NodeWorkflowRuntime` class
* Workflow/step orchestration (`runDefault`, `runNamedWorkflow`, `executeSteps`, `executeStep`, frame and scope management)
* The async-handle bookkeeping (`getAsyncIndices`, `getFrameStack`)
* Heartbeat (`startHeartbeat`, `stopHeartbeat`, `writeHeartbeat`)

Target size for `node-workflow-runtime.ts` after split: ~900–1100 LoC. Still large, but a single coherent concern (the orchestrator).

**Non-goals**

* Do not change behavior. Every existing test must still pass without modification.
* Do not redesign the event format, the mock contract, or the arg-parser's accepted syntax. This is a relocation task only.
* Do not split further than the three new modules listed. Over-decomposition is its own problem; this task is calibrated for one round of splitting.
* Do not touch `node-workflow-runner.ts` (the CLI shim) or `run-step-exec.ts` (subprocess plumbing) — those are already correctly sized and out of scope.

**Acceptance criteria**

* `src/runtime/kernel/node-workflow-runtime.ts` is between 900 and 1100 LoC after the split.
* `src/runtime/kernel/runtime-arg-parser.ts`, `runtime-event-emitter.ts`, `runtime-mock.ts` exist and own their respective concerns.
* `runtime-arg-parser.test.ts` exists with direct unit tests for the extracted helpers.
* `npm test` passes with no test changes other than possibly importing helpers from their new location.
* No `require("node:...")` calls inside class methods (they are replaced by top-of-file `import` statements as part of the mock extraction).
* The new modules have no circular imports back into `node-workflow-runtime.ts`. Dependency direction is one-way: orchestrator → helpers/emitter/mock.

***
