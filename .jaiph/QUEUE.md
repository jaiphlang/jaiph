# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

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
