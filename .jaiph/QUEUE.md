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

## Simplification: redesign step output contract (status/value/logs) <!-- dev-ready -->

**Problem.** Output semantics are currently ambiguous: shell-like stdout capture and Jaiph step artifacts overlap, so users cannot reliably tell what is "return value" vs "log stream".

**Goal.** Define and adopt a single step contract:

- **Status**: exit code (`0` success, non-zero failure), with strict `set -e` behavior.
- **Value**: explicit `return` value used for assignment capture (for rules, workflows, and functions).
- **Logs**: stdout/stderr process output written to run artifacts (`.jaiph/runs/.../*.out|*.err`) and optionally streamed live.

**Spec table to implement (and copy into `docs/grammar.md`).**

| Step kind | Status source | Value channel (for `x = ...`) | Log channel |
| --- | --- | --- | --- |
| `shell` | shell exit code | full stdout of shell command | stdout/stderr to step artifacts |
| `ensure rule` | rule exit code | explicit rule `return` value only | all rule command stdout/stderr to step artifacts |
| `run workflow` | workflow exit code | explicit workflow `return` value only | all workflow step stdout/stderr to step artifacts |
| `function call` | function exit code | explicit function `return` value only | all function command stdout/stderr to step artifacts |
| `prompt` | prompt command exit code | final assistant answer only | prompt transcript/reasoning/tool logs to artifacts |
| `log` / `logerr` | always `0` unless runtime error | empty | message emitted as log event (+ stdout for `log`, stderr for `logerr`) |

**Scope.**

- Keep bash-like redirection and pipelines for raw shell command streams.
- For Jaiph-level composition (`x = ensure rule`, `x = run wf`, `x = fn`), assignment captures only explicit `return` values.
- Preserve current event emission and run artifact structure.

**Acceptance criteria.**

- Table above is added to `docs/grammar.md` in runtime semantics.
- All command stdout/stderr from rules/workflows/functions is written to `.jaiph/runs` artifacts.
- Assignment capture for `ensure`, `run`, and function calls reads only explicit `return` values.
- No accidental `echo`/shell stdout capture into assignment values for rules/workflows/functions.
- Prompt capture returns final answer value while transcript remains in artifacts.
- e2e tests cover all rows from the spec table (`shell`, `ensure rule`, `run workflow`, `function call`, `prompt`, `log`/`logerr`) and validate both value channel behavior and `.jaiph/runs` log artifacts for each.
- Add a dedicated e2e for `ensure ... recover ...` value semantics: assignment returns the last successful rule `return` value, and the `recover` block receives the rule `return` value (not command stdout/output stream).

## Feature Jaiph reporting server + lightweight dashboard UI (runs-dir backed) <!-- dev-ready -->

**Problem.** Jaiph has run artifacts (`.jaiph/runs/**`) and runtime events, but no built-in way to browse run history, inspect step trees, and review logs/responses in a single lightweight UI.

**Goal.** Add a standalone reporting server with a minimal dashboard that uses `.jaiph/runs` as its primary database, plus optional live event ingestion for in-progress runs.

**First-principles constraints.**

- Reuse existing artifacts and `run_summary.jsonl`; do not introduce a heavy database for v1.
- Keep implementation lightweight: server + static HTML/CSS/JS (no SPA framework required).
- Preserve backwards compatibility with existing run artifact format.
- Support local use first (`localhost`), with optional event push via `JAIPH_REPORTING_URL`.

**Data model (source of truth).**

- **Historical source:** `.jaiph/runs/<date>/<time>-<source>/run_summary.jsonl` + `*.out` + `*.err`.
- **Tree reconstruction:** use `id`, `parent_id`, `seq`, `depth`, `kind`, `name`, `params`, `status`, `elapsed_ms`.
- **Step output:** use embedded `out_content` / `err_content` for quick views; `.out/.err` for full/raw views.
- **Optional live file (server-managed):** `<run_dir>/events.live.jsonl` for non-finalized events (`STEP_START`, `LOG`, `LOGERR`) to support real-time dashboard state across server restarts.

**Reporting modes.**

1. **History-only mode (required):**
   - Server reads existing runs from `.jaiph/runs` and serves history/tree/log views.
2. **Live mode (required):**
   - Server accepts runtime events via HTTP (`POST /api/events`) and updates active run state.
   - Runtime can push events when `JAIPH_REPORTING_URL` is set (best-effort, non-blocking).

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
- `POST /api/events`
  - ingests single runtime event payload; updates in-memory active runs and optional `events.live.jsonl`.
- `GET /api/active`
  - returns currently running workflows with live step status.

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

**Runtime integration.**

- Introduce `JAIPH_REPORTING_URL` support in runtime event emission path.
- On each event emission:
  - send best-effort HTTP POST to reporting URL,
  - never fail workflow execution if reporting endpoint is unavailable,
  - keep existing stderr marker + run_summary behavior unchanged.
- Include run/workspace metadata in payload needed for server correlation.

**Reliability/performance requirements.**

- Run directory scan should be incremental/cached (avoid full rescan on each request).
- Handle large runs safely:
  - response size caps for embedded output preview,
  - streaming for raw logs and aggregate views.
- Keep endpoint latency low for local use (target p95 < 200 ms for common metadata endpoints on moderate history sizes).

**Security/safety (v1).**

- Bind localhost by default.
- Read-only over run artifacts (except optional `events.live.jsonl` append).
- Sanitize/normalize run path resolution to prevent directory traversal.

**Acceptance criteria.**

- With no extra setup, starting the reporting server on a project with `.jaiph/runs` shows historical runs and allows browsing:
  - tree,
  - step response,
  - raw out/err logs,
  - aggregated output view.
- A run in progress appears in the active section and updates live.
- If live reporting is disconnected, workflow execution still succeeds; history remains browsable from run artifacts.
- `JAIPH_REPORTING_URL` is documented and covered by tests (happy path + endpoint-down behavior).
- End-to-end test validates:
  - run list discovery from `.jaiph/runs`,
  - correct tree reconstruction from summary data,
  - log browsing and aggregate output endpoint behavior,
  - live event ingestion updates active run state.

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
