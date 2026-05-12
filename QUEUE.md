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
