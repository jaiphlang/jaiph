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

## Sandbox — fix concurrent-run race in `discoverDockerRunDir` via run-id stamping #dev-ready

**Goal**
`discoverDockerRunDir` (in `src/cli/shared/errors.ts`) finds the run directory by scanning the bind-mounted runs root and picking the lexicographically-latest dir with a `run_summary.jsonl`. Two parallel `jaiph run` invocations sharing `JAIPH_RUNS_DIR` race: the host CLI for run A may report run B's directory in its failure footer. The non-Docker path doesn't have this issue because it uses a per-process `metaFile`.

**Context (read before starting)**

* `discoverDockerRunDir` in `src/cli/shared/errors.ts` (lines ~205–229) does the scan.
* The runtime already emits a `run_id` in `WORKFLOW_START` (visible in `.jaiph/runs/<date>/<time>-<src>/run_summary.jsonl`).
* The host CLI can generate a UUID per `runWorkflow` invocation and forward it as `JAIPH_RUN_ID` into the container env. The runtime, if `JAIPH_RUN_ID` is set, uses that as the workflow run id instead of generating its own.

**Scope**

* In `src/cli/commands/run.ts`, generate a fresh UUID per invocation and put it on `runtimeEnv.JAIPH_RUN_ID` before spawning Docker (or the local runtime).
* In the runtime kernel (search for where `runId` is generated, likely `src/runtime/kernel/node-workflow-runtime.ts`), prefer `process.env.JAIPH_RUN_ID` when set, else generate as today.
* Rewrite `discoverDockerRunDir` to take an extra `expectedRunId: string` argument and pick the directory whose `run_summary.jsonl` first line is a `WORKFLOW_START` with that `run_id`. Update its caller in `src/cli/commands/run.ts`.
* Add a unit test for `discoverDockerRunDir` that creates two run dirs in the same root and asserts the correct one is returned for each id.
* Update env forwarding allowlist if needed (already covered by `JAIPH_*`).

**Non-goals**

* Do not change the on-disk run-dir naming scheme (date/time/source).
* Do not change `run_summary.jsonl` event shape — `run_id` already exists.

**Acceptance criteria**

* `JAIPH_RUN_ID` env, when set, is used by the runtime as the workflow run id.
* `discoverDockerRunDir(sandboxRunDir, expectedRunId)` returns the matching dir even when a newer unrelated run dir exists alongside it (covered by new unit test).
* `npm test` and the four `e2e/tests/7*_docker_*.sh` still pass.

***

## Sandbox — fail fast with `E_DOCKER_UID` when host UID detection fails on Linux #dev-ready

**Goal**
Linux copy mode currently does `process.getuid()` then falls back to `id -u`. If both fail, no `--user` flag is passed and the container runs as root. Files in the cloned workspace and `/jaiph/run` get owned by root; subsequent host-side `rmSync` may fail; the user gets a confusing permission error far from the cause. Replace the silent degradation with a hard failure that names the problem.

**Context (read before starting)**

* The fallback chain lives in `buildDockerArgs` in `src/runtime/docker.ts` (lines ~644–667).
* Overlay mode intentionally runs as `--user 0:0` (the entrypoint drops to host UID via `setpriv`); only copy mode is affected.

**Scope**

* In `buildDockerArgs`, when `process.platform === "linux"` and mode is `"copy"`, treat missing `hostUid`/`hostGid` as a fatal error: throw `Error("E_DOCKER_UID failed to determine host UID/GID; refusing to run sandbox as root.")`.
* In overlay mode keep the existing behavior (root in container is intentional, but the JAIPH_HOST_UID/GID env vars are required for the entrypoint to drop privileges — if they would be missing, also throw `E_DOCKER_UID` so the container does not run as root unconditionally).
* Add unit tests asserting the throw on a stubbed Linux platform with no UID source.
* Add `E_DOCKER_UID` to the failure-modes table in `docs/sandboxing.md`.

**Non-goals**

* Do not change macOS behavior (no `--user` override there is intentional).

**Acceptance criteria**

* On Linux with no detectable UID/GID, `buildDockerArgs` throws `E_DOCKER_UID` (covered by unit test).
* `docs/sandboxing.md` failure-modes table includes the new error code.
* `npm test` and the four `e2e/tests/7*_docker_*.sh` still pass.

***

## Sandbox — reject negative `JAIPH_DOCKER_TIMEOUT` explicitly #dev-ready

**Goal**
Today `JAIPH_DOCKER_TIMEOUT="-5"` parses cleanly to `-5`, then `> 0` returns false in `spawnDockerProcess`, and the timeout silently disables. A typo like `300-` parses as `300` (ParseInt ignores trailing junk), masking the user's intent. Validate strictly.

**Context (read before starting)**

* Parsing lives in `resolveDockerConfig` in `src/runtime/docker.ts` (lines ~187–192).
* The `0 disables` semantics is documented and must stay.
* `parseInt("abc", 10)` → `NaN`, currently falls back to default. Keep that behavior.

**Scope**

* Replace the current parse with a strict integer check: accept only `^-?\d+$` matched strings; reject anything else with `Error("E_DOCKER_TIMEOUT JAIPH_DOCKER_TIMEOUT must be a non-negative integer (or 0 to disable), got \"…\"")`.
* Reject negatives with the same `E_DOCKER_TIMEOUT` error.
* Keep the "invalid integer falls back to default" behavior **only** for the historical `"abc"`-style failure already covered by `resolveDockerConfig: invalid timeout env falls back to default`. (Decide: hard-fail or default-fallback for non-integer input. Pick hard-fail for consistency with the new strictness; update or delete the old test accordingly.)
* Add `E_DOCKER_TIMEOUT` to the failure-modes table in `docs/sandboxing.md`.
* Add unit tests for: `"-5"` rejected, `"300-"` rejected, `"0"` accepted (disables), `"300"` accepted, `""` rejected.

**Non-goals**

* Do not change the in-file `runtime.docker_timeout` parse path beyond consistency with the new env validation. (If it currently accepts negatives, also tighten it here.)

**Acceptance criteria**

* `JAIPH_DOCKER_TIMEOUT="-5"` and `"300-"` both produce `E_DOCKER_TIMEOUT`.
* `JAIPH_DOCKER_TIMEOUT="0"` still disables the timeout.
* `docs/sandboxing.md` failure-modes table includes the new error code.
* `npm test` and the four `e2e/tests/7*_docker_*.sh` still pass.

***

## Sandbox — pre-pull docker image with single status line before workflow start #dev-ready

**Goal**
`pullImageIfNeeded` runs inside `resolveImage`, which runs inside `spawnDockerProcess`, which is called *after* the host CLI has already started rendering the running banner and tree. On a cold image pull, Docker's own progress UI (`Pulling from …`, layer hashes, percent bars) interleaves with the jaiph progress tree. The output is unreadable. Pre-pull before the banner; replace Docker's noisy progress with one structured status line.

**Context (read before starting)**

* The current pull happens inside `pullImageIfNeeded` in `src/runtime/docker.ts`, called from `resolveImage`, called from `spawnDockerProcess`.
* The call site in `runWorkflow` (`src/cli/commands/run.ts`) writes the banner first, then calls `spawnExec` which kicks off `spawnDockerProcess`. The order of operations is the issue.
* `imageHasJaiph` should also run pre-banner — its docker startup overhead has the same UX problem.

**Scope**

* Extract a `prepareImage(config: DockerRunConfig)` function in `src/runtime/docker.ts` that does the existing `pullImageIfNeeded` + `verifyImageHasJaiph` and returns the resolved image string. Pull progress: pass `--quiet` to `docker pull` and write a single `pulling image <name>…` line to stderr before the call, then `pulled` (or the error) after.
* Call `prepareImage` from `runWorkflow` in `src/cli/commands/run.ts` **before** `writeBanner`. The banner stays clean.
* Remove the pull/verify from `resolveImage` (or keep `resolveImage` as a thin wrapper around `prepareImage` for back-compat in tests).
* Add an e2e test in `e2e/tests/74_docker_lifecycle.sh` (or new `74c`): force a pull (use a cheap image like `alpine:3.20` not present locally), assert that stdout contains the running banner only after stderr contains a `pulling image` line.

**Non-goals**

* Do not implement layer-by-layer progress reporting via `docker pull --json`. One-line status is enough for now.
* Do not cache pull results across invocations beyond what the local Docker daemon already does.

**Acceptance criteria**

* The running banner does not appear until image preparation is done.
* On cold pull, exactly one `pulling image …` line appears on stderr; Docker's native progress is suppressed (`--quiet`).
* `npm test` and the four `e2e/tests/7*_docker_*.sh` still pass.

***

## Sandbox — extract overlay script to `runtime/overlay-run.sh` and shellcheck in CI #dev-ready

**Goal**
`OVERLAY_SCRIPT` is a 30+ line bash blob inside a TS template literal in `src/runtime/docker.ts`. Editing it requires escape-character gymnastics and the file is invisible to `shellcheck`. Move it to a real `.sh` file and lint it.

**Context (read before starting)**

* Source: `OVERLAY_SCRIPT` constant in `src/runtime/docker.ts` (lines ~293–324).
* Consumer: `writeOverlayScript()` writes the constant to a temp file, returns its path; the path is bind-mounted into the container at `/jaiph/overlay-run.sh`.
* `shellcheck` is not yet a CI dependency. Add it.

**Scope**

* Create `runtime/overlay-run.sh` with the current bash content, executable bit set in git (`git update-index --chmod=+x`).
* In `src/runtime/docker.ts`, read the file at module load (`readFileSync(join(__dirname, '../../runtime/overlay-run.sh'), 'utf8')`) — handle the `dist/` vs source path the same way `resolveDefaultImageTag` already does.
* Update `writeOverlayScript` to write the loaded content (no behavior change).
* Add `shellcheck` to `.github/workflows/ci.yml` as a dedicated job that runs `shellcheck runtime/overlay-run.sh e2e/tests/*.sh e2e/lib/*.sh`. Fix any newly surfaced violations in `runtime/overlay-run.sh` (e2e fixes are out of scope; suppress with `# shellcheck disable=…` if they break CI).
* Update existing tests in `src/runtime/docker.test.ts` (`writeOverlayScript: …`) to read from the new file location instead of the inlined constant.
* Make sure the file is included in the published npm package: add `runtime/overlay-run.sh` to the `files` array in `package.json` if not already there.

**Non-goals**

* Do not rewrite the script logic. Move-and-lint only.
* Do not shellcheck the entire e2e suite in this task; only the new file.

**Acceptance criteria**

* `OVERLAY_SCRIPT` constant no longer exists in `src/runtime/docker.ts`.
* `runtime/overlay-run.sh` exists, is executable, and is shipped in the npm package.
* `shellcheck runtime/overlay-run.sh` passes in CI.
* `npm test` and the four `e2e/tests/7*_docker_*.sh` still pass.

***

## Sandbox — refactor `cloneWorkspaceForSandbox` state-threading into a small class #dev-ready

**Goal**
`copyEntryWithCloneFallback` threads a mutable `{ cloneAttempted, cloneSupported, firstFallbackReason }` object through every recursive call. Reading the function requires holding the state machine in head. Replace with a small class instance that owns the state and exposes one method.

**Context (read before starting)**

* All affected code lives in `src/runtime/docker.ts` (`tryCp`, `copyEntryWithCloneFallback`, `cloneWorkspaceForSandbox` — lines ~360–449).
* Tests in `src/runtime/docker.test.ts` cover behavior (`cloneWorkspaceForSandbox: copies entries and excludes .jaiph/runs`, `…produces independent file inodes`, `…empty workspace`). Behavior must stay identical.

**Scope**

* Introduce a non-exported `class WorkspaceCloner` in `src/runtime/docker.ts` with private state (`cloneAttempted`, `cloneSupported`, `firstFallbackReason`) and one public method `copy(src: string, dst: string): void`.
* `cloneWorkspaceForSandbox` instantiates one cloner, calls `cloner.copy(...)` for each entry, then surfaces the one-time fallback warning by reading from the cloner.
* Delete `copyEntryWithCloneFallback` and its `state` parameter.
* No new tests required (existing tests cover behavior).

**Non-goals**

* Do not export the class. It is an implementation detail.
* Do not change the clonefile-vs-cp decision tree.

**Acceptance criteria**

* `copyEntryWithCloneFallback` and its `state` parameter no longer exist.
* `cloneWorkspaceForSandbox` is shorter and reads top-to-bottom without state plumbing.
* `npm test` still passes with no test changes.

***

## Sandbox — docs sweep: credential-leak warning + `KEEP_SANDBOX` claim fix #dev-ready

**Goal**
Two doc-only fixes in `docs/sandboxing.md`. (1) The default network is bridged with outbound access; combined with forwarded `ANTHROPIC_*`/`CURSOR_*`/`CLAUDE_*` agent credentials, a malicious script can exfiltrate API keys. The current docs bury this under "What Docker does NOT protect against" — promote it to the "Enabling Docker" section so users see it before they enable. (2) The "Runtime behavior" section claims `JAIPH_DOCKER_KEEP_SANDBOX=1` causes the path to be "printed to stderr for debugging". The code does not print. Strike the claim.

**Context (read before starting)**

* Affected file: `docs/sandboxing.md` only. No code changes.
* Section 1 location: lines ~32–38 (the "What Docker does NOT protect against" bullet about agent credential forwarding).
* Section 2 location: line ~168 ("the path is left in place and printed to stderr for debugging").

**Scope**

* In the "Enabling Docker" section (around line 56), add a clearly delimited note (e.g. blockquote) reading: "Docker is enabled by default but **does not isolate agent credentials**. `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` env vars are forwarded into the container and the default network allows outbound access. A malicious script can read these from its environment and exfiltrate them. Set `runtime.docker_network = \"none\"` for workflows that should not make external calls."
* In the "Runtime behavior" section, change "in which case the path is left in place and printed to stderr for debugging" to "in which case the path is left in place for debugging". No reference to stderr printing.
* Verify the doc still builds (Jekyll, in `docs/`).

**Non-goals**

* No code changes. None. This is a docs task.
* Do not redesign the threat model — only relocate and clarify.

**Acceptance criteria**

* `docs/sandboxing.md` "Enabling Docker" section contains the agent-credential warning blockquote.
* The phrase "printed to stderr for debugging" no longer appears in `docs/sandboxing.md`.
* `bundle exec jekyll build` (or whatever the docs CI step is) still passes.

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
