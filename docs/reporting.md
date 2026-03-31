---
title: Reporting server
permalink: /reporting
redirect_from:
  - /reporting.md
---

# Reporting server

Long-running workflows produce structured output — step boundaries, logs, and `run_summary.jsonl` events — all persisted as files under the runs root. That is ideal for automation (Unix tools, CI uploads, custom scripts) but awkward when you want a human-friendly view of history, in-flight progress, and per-step stdout/stderr without opening many paths by hand. `jaiph report` starts a read-only HTTP server with a browser UI over that same tree — no separate database and no second log format.

The server rescans the `<YYYY-MM-DD>/<run>/run_summary.jsonl` tree, tails each file incrementally, exposes JSON under `/api/…`, and serves static HTML/CSS/JS for the UI. Static files live under `src/reporting/public` in the repo. At runtime the process loads `public` next to the compiled reporting code (e.g. `dist/src/reporting/public` when you run `node dist/src/cli.js`) or, for the standalone binary, `reporting/public` next to the executable — see [Architecture — Distribution](architecture#distribution-node-vs-bun-standalone).

While a workflow is still running, the server incrementally reads newly appended summary bytes. The tail state stores a byte offset and file identity (`dev`/`ino` from `stat`). If the identity changes or the file shrinks below the stored offset (truncation or replacement), the reader clears incremental state and reloads from the beginning so parsed run state stays consistent. Implementation: `src/reporting/jsonl-tail.ts`.

For event shapes in `run_summary.jsonl`, see [CLI — Run summary (`run_summary.jsonl`)](cli.md#run-summary-jsonl). The on-disk layout under the runs root matches [CLI — Run artifacts and live output](cli.md#run-artifacts-and-live-output).

---

## Start and stop the server

The default command starts the server in the foreground and blocks until you stop it (e.g. with Ctrl+C). That mode is equivalent to an explicit `start` subcommand.

```bash
jaiph report --workspace .
jaiph report start --workspace .
```

Subcommands (optional; default is `start`):

- **`start`** — Listen for HTTP requests until the process exits. Writes a PID file so `stop`/`status` can find this process. Fails with an error if a server is already recorded as running.
- **`stop`** — Sends SIGTERM to the PID from the file (then SIGKILL after ~4 seconds if needed), removes the PID file, and exits. Exit code 1 if nothing was running (missing or stale PID file; stale files are removed).
- **`status`** — Prints whether the PID file refers to a live process. Exit code 0 if running, 1 if not.

```bash
jaiph report status
jaiph report stop
```

The PID file is JSON (`pid`, `host`, `port`, `runsRoot`, `started_at`) so you can inspect it manually if needed.

---

## Options

```bash
jaiph report --host 127.0.0.1 --port 8787
jaiph report --runs-dir /path/to/custom/runs/root
jaiph report --poll-ms 500
jaiph report --pid-file /path/to/report.pid
```

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace <path>` | Current working directory | Project directory used to resolve the default runs root as `<workspace>/.jaiph/runs`. |
| `--runs-dir <path>` | `<workspace>/.jaiph/runs` | Override the runs root: the tree of `<YYYY-MM-DD>/<run>/run_summary.jsonl` directories. Point this at the same directory `jaiph run` writes to. `jaiph report` does not load Jaiph config or inherit `JAIPH_RUNS_DIR` from the workflow process — it only reads the filesystem tree you point it at. |
| `--host <addr>` | `127.0.0.1` | Bind address. |
| `--port <n>` | `8787` | Listen port. |
| `--poll-ms <n>` | `500` | Interval in milliseconds for the server timer that tails every known `run_summary.jsonl`. Minimum 50; invalid values are rejected. Full directory rescans are rate-limited to roughly every two seconds regardless of this interval. |
| `--pid-file <path>` | `<workspace>/.jaiph/report.pid` | PID file path for `status`/`stop`. |

Environment variables mirror the flags: `JAIPH_REPORT_HOST`, `JAIPH_REPORT_PORT`, `JAIPH_REPORT_POLL_MS`, `JAIPH_REPORT_RUNS_DIR`, `JAIPH_REPORT_PID_FILE`. See [CLI — Environment variables](cli.md#environment-variables).

If the runs directory does not exist yet, the server still starts; stderr notes the path and the UI stays empty until runs appear.

---

## Browser UI

Open the URL printed on stderr when the server binds (default `http://127.0.0.1:8787`).

**Runs list (`/`)** — Table of discovered runs (path, source basename, start time, status, step counts). Sort column headers, filter by date prefix (`YYYY-MM-DD`), status (`running`, `completed`, or `failed`), and free-text search (`q`) over path, source, and `run_id`. An active-runs strip at the top summarizes workflows still in progress (step counts and a `kind:name` label for the currently running step).

**Run detail (`/run.html?run=…`)** — Left panel: expandable step tree rebuilt from `STEP_START`/`STEP_END` metadata (`id`, `parent_id`, `seq`, `depth`, `kind`, `name`, status, `elapsed_ms`). Right panel: tabs for **Response** (embedded `out_content`/`err_content` from the summary, preview-capped at 64 KB on the server), **Raw logs** (full `.out` or `.err` from disk), and **Aggregate** (plain text: each step's stdout in `seq` order — reads the `.out` file when present, otherwise embedded `out_content` — with section headers).

The pages poll JSON endpoints on a fixed cadence (the run list about every 3 seconds, active runs about 1.5 seconds, the step tree on the detail page about 2 seconds), independent of `--poll-ms`.

---

## HTTP API

All routes use GET and are read-only. Any `GET /api/…` request also advances the server's in-memory tail state for summaries, so clients do not always wait for the next `--poll-ms` tick.

Run keys in URLs are `encodeURIComponent(relativePath)` where `relativePath` uses forward slashes under the runs root (e.g. `2026-03-24%2F14-30-00-main.jh` for `2026-03-24/14-30-00-main.jh`). `stepId` in paths is the step's `id` from the summary; encode it when it contains reserved characters.

| Endpoint | Description |
|----------|-------------|
| `GET /api/runs` | Paginated list. Query params: `page` (default 1), `limit` (default 50, max 200), optional `date`, `status`, `q`. Response: `runs` (rows with `id`, `path`, `run_id`, `source`, `started_at`, `ended_at`, `status`, `step_count`, `step_completed`, `step_running`, `failed`), `total`, `page`, `page_size`. |
| `GET /api/runs/:run/tree` | Step tree. Response: `run_id`, `path`, `steps` (nested step tree roots). |
| `GET /api/runs/:run/steps/:stepId/output` | Embedded stdout/stderr preview (each capped at 64 KB). Response includes `out_content`, `err_content`, `out_truncated`, `err_truncated`, `out_file`, `err_file`. |
| `GET /api/runs/:run/steps/:stepId/logs?stream=out\|err` | Raw artifact file stream (`text/plain`, chunked). `stream` defaults to `out`. Returns 404 with empty body if the artifact path is missing. |
| `GET /api/runs/:run/aggregate` | Plain text: each step's stdout in `seq` order with separators (file preferred over embedded content, same rule as the UI). |
| `GET /api/active` | Active runs. Response: `{ "runs": [ … ] }` with entries containing `relPath`, `run_id`, `source`, `status`, `step_total`, `step_completed`, `step_running`, `percent`, `current_step_label`. |

Static assets: `/assets/…`. HTML entry points: `/` and `/run.html`.

---

## Behavior notes

**Indexing** — New run directories are picked up when the server rescans the `<YYYY-MM-DD>/<run>/run_summary.jsonl` tree. Rescans are rate-limited (about two seconds minimum between full scans; `DIR_SCAN_MIN_MS` in `src/reporting/run-registry.ts`). Between rescans, known files are still tailed on the timer interval (`--poll-ms`) and on each `GET /api/…` request.

**Safety** — Binds to loopback by default. Serves only run artifacts under the resolved runs root, with path resolution that rejects directory traversal (`src/reporting/path-utils.ts`). Starting or stopping the reporting server does not affect workflow execution.

**Correlation with the summary contract** — Event types, fields, and reporting rules for `run_summary.jsonl` are documented in [CLI — Run summary (`run_summary.jsonl`)](cli.md#run-summary-jsonl).
