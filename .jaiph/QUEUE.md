# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Fix parser bug: multiline `prompt` inside `recover` with params <!-- dev-ready -->

**Goal.** Fix the parser/runtime bug where a multiline `prompt` inside `ensure ... recover { ... }` fails with `E_PARSE unterminated prompt string`, especially when the prompt includes interpolated parameters (for example `$ci_log_file`).

**Scope.**

- Reproduce the bug with a minimal workflow using `ensure some_rule recover { prompt " ... $var ... " }`.
- Fix parsing/transpilation so multiline prompt strings are valid inside `recover` blocks and parameter interpolation is preserved.
- Ensure behavior is consistent with multiline prompts in regular workflow blocks.
- Add/extend docs only if syntax/limitations change.

**Acceptance criteria.**

- A multiline prompt inside `recover` parses and runs successfully.
- Parameter interpolation inside that multiline prompt works (e.g. `$ci_log_file` appears correctly in prompt input).
- Add a **full e2e test** that fails before the fix and passes after it, explicitly covering multiline `prompt` in `recover` with a parameter.
- Existing prompt and `ensure ... recover` tests continue to pass.

---

## Fix unrelated e2e regression from missing `.jaiph` module import <!-- dev-ready -->

**Goal.** Prevent unrelated e2e scripts (e.g. `e2e/say_hello.test.jh`) from failing because `.jaiph/main.jh` imports a missing file (`implement_from_queue.jh`), even though those tests do not target queue/implementation orchestration.

**Scope.**

- Audit `.jaiph` entrypoints/import graph and remove/replace stale module references that can break generic workflow execution.
- Add a regression test that reproduces the failure mode (`E_IMPORT_NOT_FOUND` from `.jaiph/main.jh`) and verifies it no longer occurs.
- Keep behavior of existing `.jaiph` workflows unchanged other than import-path correctness.
- Document the root cause briefly (renamed/moved module without entrypoint update) in changelog or contributor docs.

**Acceptance criteria.**

- Running `e2e/say_hello.test.jh` no longer fails with `.jaiph/main.jh ... E_IMPORT_NOT_FOUND`.
- `.jaiph/main.jh` only imports modules that exist in-repo.
- New/updated automated test fails before the fix and passes after it.
- No regressions in `.jaiph` queue/engineer/docs workflows.

---

## Fix inbox routing args contract for receiver workflows <!-- dev-ready -->

**Goal.** Clarify and fix argument passing for channel-routed workflows (`channel -> receiver`) so receivers can access both routed message and channel metadata predictably, without breaking existing workflows that already rely on current `$1` behavior.

**Problem statement.** In `e2e/agent_inbox.jh`, the routed call displays only `(channel="report")` in the step header while receiver output may not expose expected positional args clearly. We need a stable contract (for example `$1=message, $2=channel` or equivalent documented mapping) and consistent runtime behavior.

**Scope.**

- Reproduce current behavior with a focused e2e fixture that logs all receiver positional args for routed calls.
- Define the canonical receiver arg contract for routed workflow invocations and document it.
- Implement runtime/transpiler updates so routed calls populate args per that contract.
- Preserve backward compatibility for existing inbox workflows as much as possible; if incompatible, provide a migration path and docs update.

**Acceptance criteria.**

- Routed receivers can deterministically access both message payload and channel name.
- Existing `e2e/agent_inbox.jh` behavior does not regress (output content still works).
- Add/extend e2e coverage that asserts exact positional arg mapping for routed receivers.
- Docs/grammar mention the finalized mapping for channel-routed workflow args.

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
