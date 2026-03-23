# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Fix `run <workflow> ... > file` stdout semantics (async root cause) <!-- dev-ready -->

**Problem.** `run some_workflow ... > out.txt` currently writes an empty/incorrect file in normal runs because `jaiph::run_step` captures child stdout into artifacts and does not forward workflow stdout to the caller stream. This breaks async/bash-like patterns and forces users to call transpiled internals (`module::workflow::impl`) to get redirectable output.

Sample file that fails: e2e/async.jh

**Goal.** Make `run` behave like normal shell execution for stdout redirection and pipelines, while still keeping Jaiph step artifacts/events.

**Acceptance criteria.**

- `run workflow "$1" > file &` captures workflow stdout in `file` without using `::impl`.
- Piping works: `run workflow "$1" | some_filter` receives workflow stdout.
- Existing step artifacts (`*.out/*.err`) and tree events are still generated.
- No regressions for prompt capture behavior (`name = prompt ...`) and existing e2e suites.
- Add e2e coverage for redirect + background `run` and for pipeline usage.

---

## Simplification: we need to redesign how outputs are captured

I think it's good to either keep parity with bash: each echo

## Feature Jaiph reporting server

You can provide env JAIPH_REPORTING_URL, and it sends all events to the target url

Additionally you have a standalone implementation that you can start, and run it
on localhost and display progress of all tasks. An evolution of https://jakub.sh/jai/ (?)

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
