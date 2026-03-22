# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Fix inbox routing args contract for receiver workflows <!-- dev-ready -->

**Goal.** Clarify and fix argument passing for channel-routed workflows (`channel -> receiver`) so receivers can access both routed message and channel metadata predictably, without breaking existing workflows that already rely on current `$1` behavior.

**Problem statement.** In `e2e/agent_inbox.jh`, the routed call displays only `(channel="report")` in the step header while receiver output may not expose expected positional args clearly. We need a stable contract (for example `$1=message, $2=channel` or equivalent documented mapping) and consistent runtime behavior.

**Scope.**

- Reproduce current behavior with a focused e2e fixture that logs all receiver positional args for routed calls.
- Define the canonical receiver arg contract for routed workflow invocations and document it.
- Implement runtime/transpiler updates so routed calls populate args per that contract.
- Preserve backward compatibility for existing inbox workflows as much as possible; if incompatible, provide a migration path and docs update.
- Use $1=message, $2=channel, $3=sender (workflow, rule, or function name) as parameters

**Acceptance criteria.**

- Routed receivers can deterministically access both message payload and channel name.
- Existing `e2e/agent_inbox.jh` behavior does not regress (output content still works after adding missing parameters).
- Add/extend e2e coverage that asserts exact positional arg mapping for routed receivers.
- Docs/grammar mention the finalized mapping for channel-routed workflow args.

---

## Unify if-step AST types in `WorkflowStepDef` <!-- dev-ready -->

**Goal.** Collapse the six `if-*` step variants (`if_not_ensure_then_run`, `if_not_ensure_then`, `if_ensure_then`, `if_not_shell_then`, `if_not_ensure_then_shell`, and the generic form) into a single `if` step type whose `thenSteps`/`elseSteps` arrays use `WorkflowStepDef[]` instead of inline type duplicates.

**Why.** Right now adding any new step type (or fixing a bug in one) requires updating the inline type definitions in 5+ places across `types.ts`, `workflows.ts`, `emit-workflow.ts`, and `validate.ts`. The six variants exist for historical reasons, not because they represent fundamentally different semantics.

**Scope.**

- In `types.ts`: replace the six `if-*` union members with one `if` member: `{ type: "if"; negated: boolean; condition: { kind: "ensure"; ref: RuleRefDef; args?: string } | { kind: "shell"; command: string }; thenSteps: WorkflowStepDef[]; elseSteps?: WorkflowStepDef[] }`.
- In `workflows.ts` (`parseWorkflowBlock`): update the if-parsing branches to produce the unified type. No structural changes to parsing logic itself — just change what object shape is pushed to `workflow.steps`.
- In `emit-workflow.ts`: replace the six `if-*` emission branches with one `if` branch that checks `condition.kind` and `negated`. Straightforward if/else, no abstractions.
- In `validate.ts`: replace the six `if-*` validation branches with one that walks `thenSteps`/`elseSteps` as `WorkflowStepDef[]`.
- Keep all code flat and linear — no generics, no visitor pattern, no helper classes.

**Acceptance criteria.**

- `WorkflowStepDef` union has one `if` variant instead of six.
- All existing unit, acceptance, and e2e tests pass.
- Golden output tests produce identical bash output.
- No new files created — changes are in-place.

---

## Deduplicate prompt parsing in `workflows.ts` <!-- dev-ready -->

**Goal.** Extract the repeated prompt-parsing code in `workflows.ts` into a single plain function and call it from all sites (workflow body, if-then branches, recover blocks, captured/uncaptured forms).

**Why.** The same multiline-prompt + `returns` parsing logic is copy-pasted ~6 times in `workflows.ts` (1070 lines). Bug fixes (like the `recover` prompt bug in this queue) have to be applied in each copy independently.

**Scope.**

- Write one function like `parsePromptStep(filePath, lines, startIdx, rawLine, innerNo, col): { step: PromptStepDef; nextIndex: number }` that handles: single-line prompt, multiline prompt (scanning for closing quote), `returns` schema, and `captureName`.
- Replace each copy-pasted prompt-parsing block with a call to this function.
- No new abstractions — just a plain function that returns data. No classes, no generics.
- Keep it in `workflows.ts` or move to `parse/prompt.ts` if the file is still too long after dedup.

**Acceptance criteria.**

- Prompt parsing logic exists in exactly one place.
- `workflows.ts` drops below 700 lines.
- All existing tests pass, golden output unchanged.

---

## Split `runWorkflow()` in `run.ts` into focused functions <!-- dev-ready -->

**Goal.** Break the 563-line `runWorkflow()` function into separate plain functions that each do one thing, called sequentially from a shorter orchestrator.

**Why.** `runWorkflow()` currently handles config resolution, process spawning, stderr event parsing, TTY rendering, Docker setup, signal handling, hook invocation, and error reporting — all in one function with deeply nested closures. An AI (or human) editing one concern risks breaking another.

**Scope.**

- Extract `resolveRuntimeEnv(effectiveConfig, workspaceRoot, inputAbs): Record<string, string>` — the 60-line env-precedence block (lines 166-226).
- Extract `formatStepLine(...)` and `formatCompletedLine(...)` — already standalone closures, move to module-level exports.
- Extract `handleStderrLine(line, state)` — move the 100-line closure to a standalone function that takes an explicit state object instead of closing over 15+ variables. Structure the state object and handler so they can be cleanly wrapped by an event emitter later (see next task).
- Keep `runWorkflow()` as the orchestrator: build → resolve env → spawn → wire event handler → wait → report. Should be under 150 lines.
- No classes, no deep abstractions. Plain functions with explicit arguments. The event handler should accept parsed events and state — not close over rendering or hook logic directly.

**Acceptance criteria.**

- `runWorkflow()` is under 150 lines.
- No function in `src/cli/commands/run.ts` exceeds 100 lines.
- Extracted functions live in the same file or sibling files in `src/cli/` — not a deep module tree.
- All existing tests pass, no behavior change.

---

## Split `emit-workflow.ts` into per-step emitter functions <!-- dev-ready -->

**Goal.** Break the 879-line `emitWorkflow()` function into separate emitter functions, one per step type, that the main function calls in a flat switch/if chain.

**Why.** Step emission for prompt, ensure, run, shell, if, and send is duplicated between the main workflow body, `emitRecoverStep`, and `emitBranchSteps`. An AI editing prompt emission has to find and update 3 code paths.

**Scope.**

- For each step type, write one plain function: `emitEnsureStep(out, indent, step, ctx)`, `emitRunStep(out, indent, step, ctx)`, `emitPromptStepToOut(out, indent, step, ctx)`, `emitShellStep(out, indent, step, ctx)`, `emitSendStep(out, indent, step, ctx)`, `emitIfStep(out, indent, step, ctx)` where `ctx` carries `workflowSymbol`, `importedWorkflowSymbols`, `importedModuleHasMetadata`, `filePath`.
- The main workflow emission loop becomes: for each step, call the matching emitter function.
- `emitRecoverStep` and `emitBranchSteps` become the same flat dispatch — no separate implementations.
- Move emitter functions to `src/transpile/emit-steps.ts` if needed to keep files under 400 lines. No deeper nesting.
- No abstractions, no registries, no plugin systems. Just functions that push strings to an array.

**Acceptance criteria.**

- No emission logic is duplicated between workflow body, recover, and if-branches.
- `emit-workflow.ts` is under 400 lines.
- Golden output tests produce identical bash output.
- All existing tests pass.

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
