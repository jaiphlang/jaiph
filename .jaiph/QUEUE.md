# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Make step outputs persist live to artifact files (probably tee or `|` for all step kinds)<!-- dev-ready -->

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

---

## Include `type + name` on step completion lines (parallel-safe tree clarity) <!-- dev-ready -->

**Goal.** Make completion lines self-identifying (e.g. `✓ workflow reviewer (0s)`) so output stays unambiguous when multiple sibling steps run concurrently.

**Why.** Current completion lines only show `✓/✗ <time>`, which is readable for strictly sequential runs but becomes ambiguous under parallel execution where several steps may complete out of order.

**Scope.**

- Update TTY and non-TTY completion rendering to include `kind + name + elapsed` for every non-root step.
- Keep existing start-line format unchanged (including params preview/suffix behavior).
- Styling constraints:
  - success marker stays green
  - failure marker stays red
  - for success lines, label (`kind + name`) and elapsed time are dim/grey
  - for failures, preserve existing red emphasis behavior
- Ensure compatibility with nested depth/prefix formatting and root PASS/FAIL summary line.
- Rework user-facing output samples to match the new completion format, including examples in `index.html`.

**Acceptance criteria.**

- Example format is supported:
  - `✓ workflow scanner (0s)`
  - `✓ workflow analyst (0s)`
  - `✗ workflow reviewer (2s)` (color semantics preserved per failure rules)
- In concurrent runs, each completion line is attributable without relying on visual proximity to start lines.
- Include an explicit before/after sample in docs or task notes using this baseline:
  - Before:
    - `Jaiph: Running agent_inbox.jh`
    - ``
    - `workflow default`
    - `  ▸ workflow scanner`
    - `  ✓ 0s`
    - `  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="scanner")`
    - `  ✓ 0s`
    - `  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")`
    - `  ·   ℹ [reviewed] Summary: Found 3 issues in auth module`
    - `  ✓ 0s`
    - ``
    - `✓ PASS workflow default (0.2s)`
  - After:
    - `Jaiph: Running agent_inbox.jh`
    - ``
    - `workflow default`
    - `  ▸ workflow scanner`
    - `  ✓ workflow scanner (0s)`
    - `  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="scanner")`
    - `  ✓ workflow analyst (0s)`
    - `  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")`
    - `  ·   ℹ [reviewed] Summary: Found 3 issues in auth module`
    - `  ✓ workflow reviewer (0s)`
    - ``
    - `✓ PASS workflow default (0.2s)`
- Existing display tests are updated and new tests cover:
  - success/failure completion line text for multiple kinds (`workflow`, `rule`, `function`, `prompt`)
  - color-enabled vs color-disabled output semantics
  - no regression in root final PASS/FAIL formatting

---

## Support parallel processes in workflow shell steps (`& ... wait`) <!-- dev-ready -->

**Goal.** Allow users to run concurrent subprocesses inside workflow shell execution using standard Bash backgrounding (`prog1 &`, `prog2 &`, `wait`) while keeping Jaiph internals deterministic and race-safe.

**Scope.**

- Ensure generated/executed shell step wrappers preserve native Bash job control semantics for background jobs and `wait` exit codes.
- Verify runtime behavior when multiple parallel subprocesses emit output concurrently to stdout/stderr and step artifacts.
- Hardening for concurrent internal resource access:
  - inbox/channels event files and message ordering assumptions
  - `.jaiph/runs/...` artifact creation/writes (`*.out`, `*.err`, summaries, metadata)
  - run-level status/event emission (`STEP_START`/`STEP_END`, PASS/FAIL) under interleaved outputs
- Add clear failure semantics: non-zero from any awaited job must fail step/workflow per existing shell-step error model.
- Document expected behavior and constraints (e.g., users must `wait` for all background jobs before step end if they need deterministic completion).

**Acceptance criteria.**

- A workflow step using:
  - `prog1 &`
  - `prog2 &`
  - `wait`
  executes reliably, and final step exit status reflects child process outcomes.
- New/updated tests include both unit and e2e coverage for parallel subprocesses and concurrent writes.
- Regression coverage proves no corruption/regression in inbox/channels handling and `.jaiph/runs` artifacts under concurrency.
- Existing internals continue to behave correctly with interleaved output: event sequencing remains valid, summaries are complete, and final workflow status is accurate.
- Docs updated with supported parallel pattern and caveats for safe usage.

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

## Explore removing Node.js runtime dependency from Jaiph stdlib <!-- dev-ready -->

**Goal.** Investigate whether the Jaiph bash runtime's dependency on Node.js (currently `jaiph::stream_json_to_text` in `prompt.sh:19` shells out to `node -e` for JSON stream parsing) can be replaced with a pure-bash or lightweight alternative (e.g. `jq`). This would simplify the Docker image and reduce the runtime footprint.

**Scope.** Research only — identify all `node` usages in the runtime bash code, evaluate alternatives, and document findings with a recommendation. If removal is feasible, write up an implementation plan. If Node.js is the most practical choice, document why and close the ticket.

---
