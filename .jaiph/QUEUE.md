# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

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

Server needs to be implemented in a separate repository. Ultimately it will be migrated as a standalone project to a separate git repo.

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
