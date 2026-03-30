---
title: Reporting server
permalink: /reporting
redirect_from:
  - /reporting.md
---

# Reporting server

## Overview

Workflow runs leave behind files: each run is a directory with **`run_summary.jsonl`** (append-only JSON lines) and per-step **`.out`** / **`.err`** captures. That layout is easy to automate (`tail`, scripts, CI artifacts) but hard to skim when you want history, a live view of an in-flight run, and quick access to step output.

**`jaiph report`** addresses that by starting a **read-only** HTTP server with a small browser UI over the **same** tree the Node workflow runtime already writes under your runs root (see [Architecture — Core components](../ARCHITECTURE.md#core-components)). There is no separate database and no second log format: the server indexes the directory tree, tails each `run_summary.jsonl`, and serves static assets from `src/reporting/public` (bundled next to the CLI or standalone binary as described in [Architecture — Distribution](../ARCHITECTURE.md#distribution-node-vs-bun-standalone)).

While a workflow is still running, the server incrementally reads new summary lines using a byte offset plus **device and inode** so it can detect replacement, truncation, or rotation and resync safely.

For command-line flags and environment variables, see [CLI Reference — `jaiph report`](cli.md#jaiph-report). Event shapes in `run_summary.jsonl` are specified in [CLI — Run summary (`run_summary.jsonl`)](cli.md#run-summary-jsonl). The on-disk layout under the runs root matches [CLI — Run artifacts and live output](cli.md#run-artifacts-and-live-output).

---

## Start and stop the server

The default command starts the server in the **foreground** and blocks until you stop it (for example with Ctrl+C). That mode is equivalent to an explicit **`start`** subcommand.

```bash
jaiph report --workspace .
jaiph report start --workspace .
```

**Subcommands** (optional; default is **`start`**):

- **`start`** — Listen for HTTP requests until the process exits. Writes a **PID file** (see below) so `stop` / `status` can find this process. If a server is already recorded as running in that PID file, start fails with an error.
- **`stop`** — Sends **SIGTERM** to the PID from the file (then **SIGKILL** if needed), removes the PID file, and exits. Exit code **1** if nothing was running (missing or stale PID file; stale files are removed).
- **`status`** — Prints whether the PID file refers to a live process. Exit code **0** if running, **1** if not.

```bash
jaiph report status
jaiph report stop
```

The PID file is JSON (pid, host, port, resolved `runsRoot`, `started_at`) so you can inspect it manually if needed.

Common options (also available on `start`):

```bash
jaiph report --host 127.0.0.1 --port 8787
jaiph report --runs-dir /path/to/custom/runs/root
jaiph report --poll-ms 500
jaiph report --pid-file /path/to/report.pid
```

- **`--workspace`** — Project directory used to resolve the default runs root as `<workspace>/.jaiph/runs` (default: current working directory).
- **`--runs-dir`** — Override the runs root: the tree of `<YYYY-MM-DD>/<run>/run_summary.jsonl` directories. Point this at the **same** directory `jaiph run` writes to. By default that is `<workspace>/.jaiph/runs`; if you override where runs go (for example with **`JAIPH_RUNS_DIR`** or `run.logs_dir` in config for workflows), set **`--runs-dir`** or **`JAIPH_REPORT_RUNS_DIR`** to that path — the reporting server does **not** read `JAIPH_RUNS_DIR` on its own. The server only reads.
- **`--host` / `--port`** — Listen address and port (defaults favor **local-only** use: `127.0.0.1` and `8787`).
- **`--poll-ms`** — Interval in milliseconds for a **server timer** that tails every known `run_summary.jsonl` and may refresh the run-directory listing. Minimum **50**; invalid values are rejected. Full directory rescans are still **rate-limited** to roughly **every two seconds** even when this interval is shorter.
- **`--pid-file`** — PID file path for `status` / `stop` (default: `<workspace>/.jaiph/report.pid`).

Environment mirrors the flags: `JAIPH_REPORT_HOST`, `JAIPH_REPORT_PORT`, `JAIPH_REPORT_POLL_MS`, `JAIPH_REPORT_RUNS_DIR`, `JAIPH_REPORT_PID_FILE`. See [CLI — Environment variables](cli.md#environment-variables).

If the runs directory does not exist yet, the process still starts; stderr notes the path and the UI stays empty until runs appear. Run `jaiph report --help` for the usage text baked into the CLI.

---

## What you see in the browser

Open the URL printed on stderr when the server binds (default **`http://127.0.0.1:8787`**).

**Runs list (`/`)** — Table of discovered runs (path, source basename, start time, duration, status, step counts). Sort column headers, filter by **date** prefix (`YYYY-MM-DD`), **status** (`running`, `completed`, or `failed`), and free-text **search** (`q`) over path, source, and `run_id`. An **active runs** strip at the top summarizes workflows still in progress (step counts and a short **current** label when the summary shows a running step, as `kind:name`).

**Run detail (`/run.html?run=…`)** — Left: expandable **step tree** rebuilt from `STEP_START` / `STEP_END` metadata (`id`, `parent_id`, `seq`, `depth`, `kind`, `name`, status, `elapsed_ms`). Right: tabs for **Response** (embedded `out_content` / `err_content` from the summary, preview-capped on the server), **Raw logs** (full `.out` or `.err` from disk), and **Aggregate** (plain text: each step’s **stdout** in `seq` order—reads the `.out` file when present, otherwise embedded `out_content`—with section headers). The pages **poll** JSON endpoints on a fixed cadence (the run list about every **3** seconds, active runs about **1.5** seconds, the step tree on the detail page about **2** seconds), independent of `--poll-ms`.

---

## HTTP API (v1)

All supported routes use **GET** and are read-only. Any **`GET /api/…`** request also advances the server’s in-memory tail state for summaries (so clients do not always wait for the next `--poll-ms` tick).

Run keys in URLs are **`encodeURIComponent(relativePath)`** where `relativePath` uses forward slashes under the runs root (for example `2026-03-24%2F14-30-00-main.jh` for `2026-03-24/14-30-00-main.jh`). **`stepId`** in paths is the step’s `id` from the summary; encode it when it contains reserved characters.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/runs` | Paginated list. Query: `page` (default **1**), `limit` (default **50**, max **200**), optional `date`, `status`, `q`. Response includes `runs` (rows with an `id` field equal to the URL-safe run key), `total`, `page`, `page_size`. |
| `GET /api/runs/:run/tree` | JSON: `run_id`, `path`, and `steps` (nested step tree roots). |
| `GET /api/runs/:run/steps/:stepId/output` | JSON: embedded stdout/stderr preview (each capped at **65,536** characters — `64 * 1024` in code), with `out_truncated` / `err_truncated`, plus `out_file` / `err_file` paths from the summary. |
| `GET /api/runs/:run/steps/:stepId/logs?stream=out\|err` | Raw artifact stream (`text/plain`, chunked). **`stream`** defaults to **`out`**. **404** with an empty body if that artifact path is missing. |
| `GET /api/runs/:run/aggregate` | Plain text: each step’s stdout in `seq` order with separators (file preferred over embedded content, same rule as the UI). |
| `GET /api/active` | JSON object `{ "runs": [ … ] }` of runs whose derived status is **running** (progress fields mirror the UI strip). |

Static assets live under `/assets/…`; HTML entry points are `/` and `/run.html`.

---

## Behavior notes

**Indexing** — New run directories are picked up when the server rescans the `<YYYY-MM-DD>/<run>/run_summary.jsonl` tree. Rescans are **rate-limited** (about **two seconds** minimum between full scans). Between rescans, known files are still **tailed** on the timer interval and on each **`GET /api/…`** request.

**Live updates** — For each summary file, the tail reader keeps an append offset and file identity (**`dev`** / **`ino`**). If the file is replaced, truncated, or rotated, the reader **resets** and rebuilds parser state from the beginning so stale incremental state is not reused.

**Safety** — Binds to **loopback by default**; serves only run artifacts under the resolved runs root, with path resolution that rejects directory traversal. Starting or stopping the reporting server does **not** affect workflow execution.

**Correlation with the summary contract** — Event types, fields, and reporting rules for `run_summary.jsonl` are documented in [CLI — Run summary (`run_summary.jsonl`)](cli.md#run-summary-jsonl).
