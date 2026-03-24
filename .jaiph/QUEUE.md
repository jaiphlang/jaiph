# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Simplify compiler with keyword-first invocation grammar (`ensure`/`run`) <!-- dev-ready -->

**Problem.** The compiler currently needs extra heuristics to infer call intent from shell-like forms (especially around direct function calls and substitution contexts). This increases parser/validator complexity and creates edge cases.

**Hypothesis.** If all Jaiph symbol invocations are keyword-first, the compiler pipeline can be simplified:
- `ensure <rule>`
- `run <workflow>`
- `run <function>`
- no direct symbol invocation as generic shell calls

**Goal.** Identify and implement safe simplifications in parser/AST/validator/transpiler based on this invariant, while preserving existing runtime behavior contracts.

**Scope.**
- Remove or reduce heuristic symbol-detection paths used to distinguish shell commands from Jaiph symbol calls.
- Consolidate call typing logic so invocation kind is explicit from syntax (keyword) instead of inferred.
- Simplify substitution validation by reusing explicit symbol-kind tables and keyword requirements.
- Reduce special-case emission logic tied to direct function-call capture and shell fallback ambiguity.

**Implementation constraints.**
- Keep backward-incompatible behavior intentional and documented (no silent semantic drift).
- Prefer deleting code and collapsing branches over adding new abstraction layers.
- Maintain clear compile-time errors for unsupported/legacy forms.

**Tests (mandatory).**
- Update parser/validator/transpiler tests to reflect keyword-first invocation only.
- Add regression tests proving removed heuristics are no longer needed.
- Ensure e2e suite passes with updated invocation model and no behavior regressions in managed logging/value channels.

**Acceptance criteria.**
- Compiler code paths for invocation classification are measurably simpler (fewer branches/files touched by invocation semantics).
- Invocation semantics are fully explicit in grammar and validation (no implicit Jaiph symbol invocation forms).
- Docs and changelog explain the simplification rationale and migration impact.

## Fix STEP_END embedded output JSON escaping (control chars leak as raw `__JAIPH_EVENT__`) <!-- dev-ready -->

**Problem.** `STEP_END` events embed `out_content`/`err_content`, but runtime escaping in `src/runtime/events.sh` only escapes `\`, `"`, `\n`, and `\r`. Other JSON-invalid control chars from CI logs (for example tabs or ANSI control bytes) can remain unescaped, making the event line invalid JSON.

**Observed regression.**

- CI prints raw event marker lines like `__JAIPH_EVENT__ {"type":"STEP_END",...,"out_content":"..."}` instead of rendering normal step output.
- This line then leaks into downstream output handling and can be treated as step output payload.

**Root cause (first principles).**

- Event transport depends on one invariant: every `__JAIPH_EVENT__` line must be valid JSON.
- Embedded output introduces arbitrary process bytes into JSON string fields.
- Current `jaiph::json_escape` is incomplete for JSON control-character requirements (`U+0000`-`U+001F`), so parser-side `JSON.parse(...)` can fail.
- When parsing fails, the line is treated as plain stderr and forwarded to user-visible output.

**Goal.** Make event payload encoding robust so embedded output never breaks JSON validity and never appears as raw marker lines in CI/non-TTY output.

**Scope.**

- Harden runtime JSON string escaping for all control chars required by JSON (not just newline/carriage return).
- Keep existing `STEP_END` embedded-output feature and size cap behavior.
- Add regression tests that include control characters in embedded output and assert parser/renderer behavior stays correct.

**Acceptance criteria.**

- A failing step whose output contains tabs and ANSI escape bytes still produces a valid `__JAIPH_EVENT__` JSON line.
- CLI event parsing (`parseStepEvent`) succeeds for that line; it is not forwarded as plain stderr.
- Non-TTY CI output does not show raw `__JAIPH_EVENT__ ...` lines for valid runtime events.
- Existing e2e contracts around step output and ensure/recover continue to pass.

## Non-TTY long tasks: periodic running ping line in gray (status heartbeat) <!-- dev-ready -->

**Problem.** In non-TTY mode, long-running steps can appear stalled because there is no periodic status output between start and end lines.

**Goal.** For long tasks in non-TTY mode, emit periodic heartbeat progress lines using the same label format as completion lines, while keeping the entire line gray.

**Expected output pattern.**

- Current:
  - `▸ prompt "Classify this task" (task="## Simplification: redesign step...")`
  - `✓ prompt prompt (91s)`
- Target:
  - `▸ prompt "Classify this task" (task="## Simplification: redesign step...")`
  - `· prompt prompt (running 60s)`
  - `✓ prompt prompt (91s)`

**Formatting/behavior requirements.**

- Heartbeat line uses bullet `·` and the same task label style as step-end lines (same naming convention as `✓ ...`).
- Entire heartbeat line stays gray, including marker, label, and `(running Ns)` suffix.
- Emission is periodic for long-running tasks only (avoid noisy output for short tasks).
- Applies to non-TTY mode; TTY mode behavior remains unchanged.
- Existing start/end semantics remain unchanged.

**Acceptance criteria.**

- During a long non-TTY step, at least one gray heartbeat line appears before completion.
- Heartbeat line text follows `· <label> (running <seconds>s)`.
- Label in heartbeat matches the step-end label format for that same step.
- Final completion line still prints normally with current status symbol and elapsed timing behavior.

## Runtime: persist complete reporting event stream in `run_summary.jsonl` (reporting prerequisite, part 1/2) <!-- dev-ready -->

**Problem.** `run_summary.jsonl` currently lacks key event types needed for a faithful reporting UI: `LOG`, `LOGERR`, inbox message flow, and non-terminal lifecycle events.

**Goal.** Make `run_summary.jsonl` the canonical append-only runtime event stream by persisting all reporting-relevant events in order.

**Scope.**

- Persist `LOG` and `LOGERR` events with message + depth.
- Persist inbox lifecycle events:
  - message enqueued from `send`,
  - message dispatched to target workflow/channel,
  - dispatch completion with status + elapsed.
- Persist lifecycle boundaries:
  - `STEP_START` in addition to `STEP_END`,
  - `WORKFLOW_START` and `WORKFLOW_END`.
- Keep JSONL append-only format and preserve existing `STEP_END` compatibility.

**Schema/format requirements.**

- Add `event_version` (starting at `1`) for forward compatibility.
- Every event must include: `type`, `ts`, `run_id`.
- Step events must keep stable correlation fields: `id`, `parent_id`, `seq`, `depth` (where applicable).
- Inbox payload handling must include:
  - safe UI preview field,
  - full payload reference/path when payload size is large.

**Concurrency/ordering requirements.**

- JSONL remains valid under parallel inbox execution.
- Appends are lock-safe for all concurrent writers.
- Consumers can tail by byte offset and process events idempotently.

**Acceptance criteria.**

- One `run_summary.jsonl` file is sufficient to reconstruct:
  - full step lifecycle tree (start/end),
  - `log`/`logerr` timeline,
  - inbox send/dispatch/completion flow,
  - workflow start/end boundaries.
- Existing consumers reading current `STEP_END` records keep working unchanged.

## Runtime: lock event contract with docs + e2e for reportability (reporting prerequisite, part 2/2) <!-- dev-ready -->

**Problem.** Without explicit contract tests/docs, event schema can drift and break reporting pollers/UI.

**Goal.** Freeze the persisted event contract with clear docs and regression coverage.

**Scope.**

- Document event taxonomy and required fields in docs.
- Add per-event schema table (required/optional fields, semantics, correlation rules).
- Add e2e coverage for all newly persisted event types and ordering guarantees.

**Acceptance criteria.**

- Docs include event table for: `WORKFLOW_START`, `WORKFLOW_END`, `STEP_START`, `STEP_END`, `LOG`, `LOGERR`, inbox lifecycle events.
- e2e validates:
  - `LOG`/`LOGERR` persistence,
  - inbox send/dispatch/completion persistence,
  - `STEP_START` and `STEP_END` pairing consistency,
  - `WORKFLOW_START`/`WORKFLOW_END` correctness,
  - JSONL validity under parallel dispatch.
- e2e also validates schema compatibility for legacy `STEP_END` consumers.

## Feature Jaiph reporting server + lightweight dashboard UI (runs-dir backed) <!-- dev-ready -->

**Problem.** Jaiph has run artifacts (`.jaiph/runs/**`) but no built-in way to browse run history, inspect step trees, and review logs/responses in a single lightweight UI.

**Goal.** Add a standalone reporting server with a minimal dashboard that uses `.jaiph/runs` (especially `run_summary.jsonl`) as its primary database for both history and live updates via polling.

**First-principles constraints.**

- Reuse existing artifacts and `run_summary.jsonl`; do not introduce a heavy database for v1.
- Keep implementation lightweight: server + static HTML/CSS/JS (no SPA framework required).
- Preserve backwards compatibility with existing run artifact format.
- Support local use first (`localhost`).

**Data model (source of truth).**

- **Historical source:** `.jaiph/runs/<date>/<time>-<source>/run_summary.jsonl` + `*.out` + `*.err`.
- **Tree reconstruction:** use `id`, `parent_id`, `seq`, `depth`, `kind`, `name`, `params`, `status`, `elapsed_ms`.
- **Step output:** use embedded `out_content` / `err_content` for quick views; `.out/.err` for full/raw views.
- **Live source:** active run `run_summary.jsonl` files are tailed/polled incrementally (by file offset and mtime) to update in-progress state.

**Reporting modes.**

1. **History-only mode (required):**
   - Server reads existing runs from `.jaiph/runs` and serves history/tree/log views.
2. **Live mode (required):**
   - Server discovers active runs and polls their `run_summary.jsonl` files for appended events.
   - UI reflects newly appended events without page reload (poll or SSE from server-side poller).

**Server/API scope (v1).**

- `GET /api/runs`
  - returns paginated run list (id/path, start/end time, status, step counts).
- `GET /api/runs/:runId/tree`
  - returns reconstructed step tree and per-step metadata.
- `GET /api/runs/:runId/steps/:stepId/output`
  - returns `out_content`/`err_content` from summary (fast path) plus artifact paths.
- `GET /api/runs/:runId/steps/:stepId/logs?stream=out|err`
  - returns full raw `.out` or `.err`.
- `GET /api/runs/:runId/aggregate`
  - returns one aggregated text output ordered by `seq` (clear section separators per step).
- `GET /api/active`
  - returns currently running workflows with live step status derived from polled summaries.

**Lightweight UI scope (v1).**

- **Runs list page**
  - sortable table: run id, source/workflow, started, duration, status, step count.
  - quick filters: date, status, text search.
- **Run details page**
  - left panel: expandable step tree (status icons, elapsed time).
  - right panel tabs:
    - **Response** (embedded output from event summary),
    - **Raw logs** (`.out/.err`),
    - **Aggregate** (single stitched output view).
- **Active runs strip**
  - top-level compact list of currently running runs with percent/step counters.
- **No heavy frontend framework required**
  - server-rendered HTML or tiny client-side JS with fetch/SSE polling.

**Polling/indexing requirements.**

- Maintain per-run polling cursor (byte offset + last inode/mtime) to avoid full-file rereads.
- Handle file rotation/recreation safely (detect truncation and resync).
- Incrementally update derived run state (active steps, latest logs, completion status) as new lines arrive.

**Reliability/performance requirements.**

- Run directory scan should be incremental/cached (avoid full rescan on each request).
- Handle large runs safely:
  - response size caps for embedded output preview,
  - streaming for raw logs and aggregate views.
- Polling loop must be lightweight and bounded (no busy loops; configurable interval/backoff).
- Keep endpoint latency low for local use (target p95 < 200 ms for common metadata endpoints on moderate history sizes).

**Security/safety (v1).**

- Bind localhost by default.
- Read-only over run artifacts.
- Sanitize/normalize run path resolution to prevent directory traversal.

**Acceptance criteria.**

- With no extra setup, starting the reporting server on a project with `.jaiph/runs` shows historical runs and allows browsing:
  - tree,
  - step response,
  - raw out/err logs,
  - aggregated output view.
- A run in progress appears in the active section and updates live by polling appended lines in its `run_summary.jsonl`.
- If the poller is temporarily interrupted/restarted, workflow execution is unaffected and history remains browsable from run artifacts.
- End-to-end test validates:
  - run list discovery from `.jaiph/runs`,
  - correct tree reconstruction from summary data,
  - log browsing and aggregate output endpoint behavior,
  - summary polling updates active run state as events are appended.

**Out of scope (v1).**

- Multi-user auth/authz.
- Remote persistent DB backends.
- Advanced analytics/metrics dashboards.

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
