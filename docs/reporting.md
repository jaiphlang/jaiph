---
title: Reporting server
permalink: /reporting
redirect_from:
  - /reporting.md
---

# Reporting server

Workflow runs leave structured artifacts under the workspace: an append-only **`run_summary.jsonl`** per run, plus per-step **`.out`** / **`.err`** files. That layout is ideal for tooling, but browsing history across many runs usually means opening directories and tailing files by hand.

**Jaiph’s built-in reporting server** is a small, read-only HTTP service plus a minimal browser UI. It indexes the same directories **`jaiph run`** already writes to—no extra database and no change to the artifact format—so you can review past runs, inspect the step tree, and read outputs in one place. While a workflow is still executing, the server **tails** each active `run_summary.jsonl` (byte offset plus inode/size) so the dashboard can refresh without reloading the whole file.

The implementation is intentionally lightweight (Node `http` + static HTML/CSS/JS). Long term it may move to a **standalone repository**; the CLI command and behavior described here track the in-repo version.

---

## Start the server

From a project that uses the default runs layout:

```bash
jaiph report --workspace .
```

Common options:

```bash
jaiph report --host 127.0.0.1 --port 8787
jaiph report --runs-dir /path/to/custom/runs/root
jaiph report --poll-ms 500
```

- **`--workspace`** — Directory whose default runs root is `<workspace>/.jaiph/runs` (default: current working directory).
- **`--runs-dir`** — Override the runs root explicitly (same role as `JAIPH_RUNS_DIR` for workflows).
- **`--host` / `--port`** — Listen address and port (defaults favor **local-only** use).
- **`--poll-ms`** — How often the server wakes its summary tail loop (minimum **50** ms). The browser polls APIs on its own cadence.

Environment mirrors the flags: `JAIPH_REPORT_HOST`, `JAIPH_REPORT_PORT`, `JAIPH_REPORT_POLL_MS`, `JAIPH_REPORT_RUNS_DIR`. See [CLI Reference — Environment variables](cli.md#environment-variables).

If the runs directory does not exist yet, the process still starts; the UI stays empty until runs appear.

---

## What you see in the browser

Open the URL printed on stderr (default **`http://127.0.0.1:8787`**).

**Runs list (`/`)** — Table of discovered runs (path, source basename, start time, duration, status, step counts). Sort column headers, filter by **date** prefix (`YYYY-MM-DD`), **status**, and free-text **search** (`q`) over path, source, and `run_id`. An **active runs** strip at the top summarizes workflows still in progress (step counts and a short “current” label when inferable).

**Run detail (`/run.html?run=…`)** — Left: expandable **step tree** rebuilt from `STEP_START` / `STEP_END` metadata (`id`, `parent_id`, `seq`, `depth`, `kind`, `name`, status, `elapsed_ms`). Right: tabs for **Response** (embedded `out_content` / `err_content` from the summary, preview-capped), **Raw logs** (full `.out` or `.err` from disk), and **Aggregate** (one plain-text view stitched in `seq` order with section headers). The page **polls** the tree endpoint periodically so in-flight runs update without a full reload.

---

## HTTP API (v1)

All paths are **GET**, read-only. Run keys in URLs are **`encodeURIComponent`** of the run’s path under the runs root, using forward slashes (e.g. `2026-03-24/14-30-00-main.jh`).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/runs` | Paginated list. Query: `page`, `limit` (≤ 200), optional `date`, `status`, `q`. |
| `GET /api/runs/:run/tree` | Step tree roots + nested children + metadata. |
| `GET /api/runs/:run/steps/:stepId/output` | JSON: embedded stdout/stderr preview (capped, with `*_truncated` flags), plus `out_file` / `err_file` paths from the summary. |
| `GET /api/runs/:run/steps/:stepId/logs?stream=out\|err` | Raw artifact stream (`text/plain`, chunked). |
| `GET /api/runs/:run/aggregate` | Plain text: each step’s stdout in `seq` order with separators (streams `.out` when present, otherwise embedded content). |
| `GET /api/active` | JSON list of runs considered **active** from the latest summary state. |

Static assets live under `/assets/…`; entry pages are `/` and `/run.html`.

---

## Behavior notes

**Indexing** — The server rescans the date/run directory tree on a **bounded interval** (on the order of a couple of seconds), not on every request, and keeps parsed state per run in memory.

**Live updates** — For each `run_summary.jsonl`, the tail reader stores **offset** and **file identity** (`dev`/`ino`). If the file is replaced, truncated, or rotated, the reader **resets** and rebuilds parser state from the beginning so corrupted incremental state is not reused.

**Safety** — Binds to **loopback by default**; serves only run artifacts under the resolved runs root, with path normalization to block directory traversal. Starting or stopping the reporting server does **not** affect workflow execution.

**Correlation with the summary contract** — Event shapes and reporting rules for `run_summary.jsonl` are documented in [CLI — Run summary (`run_summary.jsonl`)](cli.md#run-summary-jsonl).

---

## Further reading

- [CLI Reference — `jaiph report`](cli.md#jaiph-report) — Flags, defaults, and env vars.
- [CLI — Run artifacts and live output](cli.md#run-artifacts-and-live-output) — Where `.out` / `.err` files live on disk.
