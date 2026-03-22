# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Add runtime event emitter for CLI reporting <!-- dev-ready -->

**Goal.** Replace the direct coupling between stderr event parsing and consumers (TTY rendering, hooks, state tracking) with a simple event emitter that consumers subscribe to. The emitter becomes the single source of truth for runtime events.

**Why.** Today `handleStderrLine` in `run.ts` directly calls TTY rendering code, hook invocation, and state mutation in the same function body. Adding a new consumer (e.g. a JSON-stream API mode, a web dashboard, a test harness) means editing that function. An event emitter decouples event production from consumption so each consumer is a standalone subscriber.

**Design constraints.**

- Plain object with `on(event, callback)` and `emit(event, data)`. No class hierarchy, no generics, no EventEmitter inheritance. Just a typed record mapping event names to callback arrays.
- Event types reuse existing `StepEvent` and `LogEvent` from `src/cli/run/events.ts` plus a few lifecycle events: `workflow_start`, `workflow_end`, `stderr_line` (raw, for passthrough).
- File: `src/cli/run/emitter.ts`. Under 80 lines. One `createRunEmitter()` factory function that returns the emitter object.
- Subscribers are plain functions registered in `runWorkflow()` before spawning the process: one for TTY rendering, one for hooks, one for state tracking.

**Scope.**

- Create `src/cli/run/emitter.ts` with `createRunEmitter()`.
- In `runWorkflow()` (or the orchestrator after the split): create emitter, register subscribers, wire the stderr parser to call `emitter.emit(...)` instead of directly calling rendering/hooks.
- Move hook invocation (`runHooksForEvent`) to a subscriber function.
- Move TTY rendering (step start/end lines, running timer updates) to a subscriber function.
- Keep the event types and parsing unchanged — the emitter sits between the parser and the consumers.

**Acceptance criteria.**

- `src/cli/run/emitter.ts` exists and is under 80 lines.
- The stderr parser emits events through the emitter, not directly to consumers.
- TTY rendering, hooks, and state tracking are each a separate subscriber — not interleaved in one function.
- Adding a new consumer (e.g. JSON-line output mode) requires only adding a new subscriber, not editing existing ones.
- All existing tests pass, no behavior change in CLI output or hook invocation.

---

## Detect and fill test coverage gaps <!-- dev-ready -->

**Goal.** Systematically identify untested or under-tested code paths across the compiler, runtime, and CLI, then produce the missing tests.

**Why.** The test suite has grown organically alongside features. Some areas (error paths, edge cases in the parser, config precedence, signal handling, Docker mode) may lack coverage. Gaps become regressions when refactoring.

**Scope.**

- Audit every parser code path (`src/parse/*.ts`) against existing unit/acceptance tests in `test/`. Identify parse branches with no corresponding test case.
- Audit every emitter code path (`src/transpile/emit-workflow.ts`, `emit-test.ts`) against golden output tests. Identify emit branches with no golden fixture.
- Audit every e2e test (`e2e/tests/*.sh`) against the feature list in docs. Identify features with no e2e coverage.
- Audit CLI commands (`run`, `build`, `test`, `init`, `use`) for error-path coverage.
- For each gap found: write the appropriate test type (see testing philosophy in `docs/contributing.md`).
- Run `npm test` and `npm run test:e2e` after adding tests to confirm they pass on current code.

**Test type selection guide.**

- **Compiler correctness** (does `.jh` input produce expected `.sh` output?) → golden output test in `test/fixtures/` + `test/expected/`.
- **Parser edge cases** (error messages, malformed input, boundary conditions) → acceptance test in `test/acceptance/`.
- **Runtime behavior** (does the built workflow actually run correctly end-to-end?) → e2e test in `e2e/tests/`.
- **Isolated unit logic** (pure functions like param formatting, event parsing, path resolution) → unit test in `test/`.

**Acceptance criteria.**

- A coverage gap report is produced listing each gap with: file, code path, reason it matters, test type needed.
- Missing tests are written and passing.
- No existing tests are modified.
- Test count increases by at least 10 new test cases across the suite.

---

## Explore removing Node.js runtime dependency from Jaiph stdlib <!-- dev-ready -->

**Goal.** Investigate whether the Jaiph bash runtime's dependency on Node.js (currently `jaiph::stream_json_to_text` in `prompt.sh:19` shells out to `node -e` for JSON stream parsing) can be replaced with a pure-bash or lightweight alternative (e.g. `jq`). This would simplify the Docker image and reduce the runtime footprint.

**Scope.** Research only — identify all `node` usages in the runtime bash code, evaluate alternatives, and document findings with a recommendation. If removal is feasible, write up an implementation plan. If Node.js is the most practical choice, document why and close the ticket.

---

## Make step outputs persist live to artifact files (tee for all step kinds)<!-- dev-ready -->

**Goal.** Ensure every step writes to its `.jaiph/runs/.../*.out`/`*.err` files incrementally while it executes (not only at step end), so logs are always tail-able in real time.

**Scope.**

- Update runtime step execution (`src/runtime/steps.sh`) so non-prompt steps also stream output live to artifact files (prompt already uses `tee`).
- Preserve existing semantics for step status, `run_summary.jsonl`, and event emission (`STEP_START`/`STEP_END`).
- Avoid double-printing in normal run output and keep test-mode behavior stable.
- Keep file writes bounded and efficient (no per-byte shell loops; use process-level redirection/`tee` patterns).

**Acceptance criteria.**

- During execution of a long-running non-prompt step, the corresponding `.out` and/or `.err` file grows before step completion.
- Existing tests for prompt output and run artifacts continue to pass.
- Add/extend tests (unit/e2e) proving live file growth behavior for at least one non-prompt step.
- No regression in final PASS/FAIL reporting and step timing output.

---

## TTY live pane: show last 10 lines of active run output under RUNNING <!-- dev-ready -->

**Goal.** In interactive TTY mode, display an ephemeral live pane under the `RUNNING workflow ...` status line that shows the latest ~10 lines from active step output; remove this pane when workflow finishes.

**Scope.**

- TTY-only rendering in CLI run path (`src/cli/commands/run.ts`), without changing non-TTY output format.
- Show an empty spacer line plus 10 tail lines, refreshed live and cursor-safe.
- Source lines from active run output in a way that avoids heavy polling and avoids re-reading entire files repeatedly.
- Keep existing tree/progress flow intact: step start/end lines, logs, and final PASS/FAIL summary remain readable and stable.
- Add guardrails for performance (bounded buffer, throttled redraw cadence, ANSI/control-char handling).

**Acceptance criteria.**

- While workflow is running in a PTY/TTY, the live pane appears below `RUNNING` and updates with recent output.
- Pane is cleared/removed before final PASS/FAIL line is shown.
- Non-TTY runs are unchanged.
- PTY/e2e tests are added or updated to verify pane lifecycle (appears during run, absent at completion) and no regressions in existing progress-tree behavior.

---

## Make `if ! run workflow` transpile like `if ! ensure rule` <!-- dev-ready -->

**Goal.** Remove the control-flow inconsistency where `if ! run some_workflow; then ... fi` behaves differently from `if ! ensure some_rule; then ... fi`, causing generated Bash to execute `run`/`prompt` as shell commands.

**Scope.**

- Update parser/transpiler handling so workflow calls in `if` conditions are emitted via transpiled workflow symbols, not raw DSL tokens.
- Match `if ! ensure` behavior semantics for negation, args forwarding, then/else branch execution, and exit-code handling.
- Add regression coverage for:
  - `if ! run wf; then prompt ...; run ...; fi`
  - positive `if run wf; then ... fi`
  - imported workflow refs (`if ! run alias.wf; then ... fi`)

**Acceptance criteria.**

- Generated Bash never contains raw DSL `run`/`prompt` tokens in conditional branches.
- `if run` and `if ! run` work for local and imported workflow refs with arguments.
- Existing `if ! ensure` tests continue to pass unchanged.

---

## Support `config` blocks inside `workflow` (scoped overrides) <!-- dev-ready -->

**Goal.** Allow an optional `config { ... }` block inside a `workflow { ... }` body so agent/run settings can differ per workflow within the same `.jh` file, with clear precedence versus module-level `config` and environment variables.

**Why.** Today only one module-level `config` is allowed per file, so every workflow in a module shares the same agent backend, model, flags, and run options. Users who want different agent settings per workflow must split into multiple files or rely on undocumented shell tricks.

**Scope.**

- Grammar/parser: accept `config { ... }` as a workflow step (or dedicated leading clause inside the workflow body), reusing the same key/value grammar as module-level config. Reject duplicate module-level config remains; define whether multiple workflow-level configs in one workflow are allowed (prefer: at most one per workflow, at the start of the body after comments, matching module conventions).
- Transpiler: wrap workflow body execution (or each step) in a metadata scope that applies workflow-local overrides, consistent with existing `with_metadata_scope` / `*_LOCKED` semantics from the outer run.
- Document precedence in `docs/configuration.md` and `docs/grammar.md`: env > module config > workflow config > defaults (or the actual resolved order you implement — document it precisely).
- Nested `run` into another module: behavior must remain coherent with current “callee fills unset vars” rules; extend docs if workflow-local scopes interact with cross-module calls.

**Acceptance criteria.**

- At least one workflow in a file can override `agent.*` / `run.*` (and any other keys that make sense) while another workflow in the same file keeps the module default or a different override.
- Environment variables set at `jaiph run` invocation still win over both module and workflow in-file config where applicable (`*_LOCKED` behavior preserved or intentionally extended and documented).
- **E2E:** New tests under `e2e/` (and matching `e2e/tests/*.sh` drivers) that verify:
  - **Scoping:** a setting changed in workflow A is not visible after A finishes when workflow B runs in the same process (or is restored per your design), and prompts/shell in B see the expected values.
  - **Overriding:** workflow-local config overrides module-level config for steps inside that workflow; module-level applies when workflow has no inner `config`.
  - **Interaction:** at least one case involving nested `run` or a follow-on workflow in the same file shows the documented precedence (no silent wrong backend/model).
- Unit/parser tests as needed for parse errors (invalid keys, duplicate inner config if disallowed).
- `docs/configuration.md` and `docs/grammar.md` updated to describe inner workflow config and precedence.
