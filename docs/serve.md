---
title: Serve workflows over HTTP
permalink: /how-to/serve
diataxis: how-to
---

# Serve workflows over HTTP

This recipe turns a `.jh` file into an HTTP API: `jaiph serve ./tools.jh` exposes the file's workflows as endpoints, publishes a machine-readable [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document, and serves a browser-usable Swagger UI. Anything that speaks HTTP — a CI job, a Kubernetes deployment, another service, a human with a browser — can invoke tested workflows and inspect their runs without an MCP client or a local jaiph install.

It reuses the same compile-time validation, sandboxed execution, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run), and the same exposure rules as [`jaiph mcp`](mcp.md). Where MCP binds the server to a co-located stdio parent, `jaiph serve` makes the workflows reachable over the network.

> **Security:** an HTTP-exposed workflow is arbitrary shell reachable by anyone who can reach the port (and, if set, holds the token) — that is the point. Bind to loopback for local use; for anything else set `JAIPH_SERVE_TOKEN`, put the server behind a TLS-terminating reverse proxy / ingress (the process speaks plain HTTP), and treat the run directory as sensitive.

## Prerequisites

- A `.jh` file with at least one workflow.
- Agent credentials for any exposed workflow that uses `prompt` — see [Authenticate agent backends](/how-to/agent-auth). Set them on the **host**; in Docker mode the backend's credential keys are forwarded through the env allowlist. Forward any other host variable a workflow needs with `--env` (same rules as `jaiph run`).

## 1. Start the server

```bash
jaiph serve ./tools.jh
# jaiph serve: listening on http://127.0.0.1:5247 — API docs at http://127.0.0.1:5247/docs (2 workflow(s))
```

Defaults are `--host 127.0.0.1` and `--port 5247`. All logs go to stderr. Startup validates the file exactly like [`jaiph mcp`](cli.md#jaiph-mcp): a compile diagnostic prints `file:line:col CODE message` to stderr and exits `1`.

## 2. Discover the workflows

```bash
curl -s http://127.0.0.1:5247/v1/workflows | jq
```

`GET /openapi.json` returns the full OpenAPI 3.1 document (one path per workflow, each with the workflow's `#`-comment description and its parameters as a JSON request-body schema). `GET /healthz` is an unauthenticated liveness/readiness probe.

## 3. Invoke a workflow

A run is a durable resource. `POST /v1/workflows/{name}/runs` starts one; the body is a JSON object of the workflow's parameters (all strings).

```bash
# Async: 202 + a Location header pointing at the run resource.
curl -si -X POST http://127.0.0.1:5247/v1/workflows/greet/runs \
  -H 'content-type: application/json' -d '{"name":"world"}'

# Synchronous: block until the run is terminal, then return the final object.
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -d '{"name":"world"}' | jq
```

The run object is `{run_id, workflow, status, started_at, ended_at, exit_status, signal, result_text, run_dir}`. `result_text` is the same content an MCP client sees — the workflow's `return` value, or its failure narrative. Failure narratives are credential-redacted (`[REDACTED]`) the same way as the event journal; the `return` value of a successful run is intentional API output and returned verbatim. **A workflow failure is not an HTTP error:** a failed run comes back `200`/`202` with `status: "failed"` and a `run dir:` pointer in `result_text`. Poll `GET /v1/runs/{id}` for an async run, list them with `GET /v1/runs` (newest first, paginated — `?limit=` defaults to 100 and is clamped to 1000, `?offset=` skips that many; the response carries `{runs, total, limit, offset}`), and stop one with `POST /v1/runs/{id}/cancel`.

## 4. Watch a run as it executes

`GET /v1/runs/{id}/events` streams the run's durable event journal (`run_summary.jsonl`) — the same timeline the CLI progress tree is built from. Two modes:

```bash
# Snapshot (default): the whole journal as newline-delimited JSON, then close.
curl -s http://127.0.0.1:5247/v1/runs/$ID/events

# Live: Server-Sent Events — replays the journal so far, then follows it as the
# run appends, and closes with an `event: end` when the run is terminal.
curl -sN -H 'accept: text/event-stream' http://127.0.0.1:5247/v1/runs/$ID/events
```

Each SSE message is a `data:` line carrying one raw journal line (`WORKFLOW_START`, `STEP_START`/`STEP_END`, `LOG*`, `PROMPT_*`, `WORKFLOW_END`); a `:ka` comment every 15 s keeps proxies from idling the connection out. Connect while the run is still going to watch step-by-step, or after it finishes for a full replay plus an immediate `event: end`. (Add `-H 'authorization: Bearer <token>'` when a token is set — `curl -N` disables buffering so events surface as they arrive.)

> **Security:** the journal is served **verbatim** — the credential redaction `jaiph` applies when writing it (values of `*_API_KEY` / `*_TOKEN` / `*_SECRET` env vars become `[REDACTED]`) is the redaction guarantee. The raw per-step capture files (`NNNNNN-*.out` / `.err`) are **never** exposed by any endpoint; only the redacted journal and files a workflow explicitly publishes are reachable over HTTP.

## 5. Download a run's artifacts

Files a workflow publishes to `$JAIPH_ARTIFACTS_DIR` (see [artifacts](/how-to/artifacts)) are listable and downloadable:

```bash
# List published files: [{path, size, mtime}, ...] (empty when the run made none).
curl -s http://127.0.0.1:5247/v1/runs/$ID/artifacts | jq

# Download one by its relative path (application/octet-stream).
curl -s http://127.0.0.1:5247/v1/runs/$ID/artifacts/report.txt -o report.txt
```

The download path is resolved strictly inside the run's `artifacts/` directory and is traversal-proof: `..` segments, absolute paths, and symlinks pointing outside the directory all return `404` without touching the target file.

## 6. Use the Swagger UI

Open `http://127.0.0.1:5247/docs` in a browser to get a live form for every workflow. When a token is configured, paste it into the **Authorize** box (Swagger UI keeps it across reloads). The UI loads its assets from a pinned, SRI-verified CDN, so `/docs` needs internet access in the browser; air-gapped operators use `/openapi.json` with any locally-hosted renderer.

## 7. Require a token and expose the port

The token comes from the environment (never argv, which leaks into process listings). With it set, every `/v1/*` request must carry `Authorization: Bearer <token>`; `/healthz`, `/openapi.json`, and `/docs` stay open.

```bash
JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/v1/workflows -H 'authorization: Bearer secret' | jq
```

Binding a non-loopback `--host` **without** `JAIPH_SERVE_TOKEN` is a startup error — the server refuses to expose unauthenticated arbitrary shell. Cap simultaneous runs with `JAIPH_SERVE_MAX_CONCURRENT` (default `4`); requests beyond the cap get `429`. See [Environment variables](env-vars.md) for both.

## 8. Bound memory over a long-lived server

The concurrency cap limits *active* children, not process memory. A long-lived server accumulates run state, so three bounds keep it from growing without limit — all overridable via [environment variables](env-vars.md):

- **Per-run output caps.** `JAIPH_SERVE_MAX_OUTPUT_BYTES` (default 1 MiB) caps collected stdout, stderr, log output, and the resident `result_text` independently. Output beyond a cap is dropped and marked with a deterministic `[jaiph: output truncated — exceeded the configured byte cap]` marker, so a run that emits gigabytes still costs bounded memory and returns a self-describing result.
- **Completed-run retention.** The in-memory run registry keeps at most `JAIPH_SERVE_RETAIN_RUNS` completed runs (default 500) and drops any completed run older than `JAIPH_SERVE_RETAIN_AGE_SEC` (default 24h). The oldest terminal records evict first; **active runs are never evicted.**
- **Bounded listing.** `GET /v1/runs` is paginated (`?limit=`, `?offset=`) with a default of 100 and a hard maximum of 1000 per page, so the endpoint can never return an unbounded response.

**Eviction is in-memory only.** Dropping a run from the registry does **not** delete its durable `.jaiph/runs/<run>/run_summary.jsonl` journal or published `artifacts/` — those persist on disk (via `JAIPH_RUNS_DIR`, an `emptyDir` or PVC under Kubernetes) and are **the operator's to prune**. Once a run is evicted its API endpoints (`GET /v1/runs/{id}`, `/events`, `/artifacts`) return `404`; read the durable artifacts from the filesystem instead.

Execution honors the same env-driven sandbox as [`jaiph run`](cli.md#jaiph-run) and [Run in a Docker sandbox](/how-to/sandbox-run): a Docker sandbox with an isolated workspace by default. `JAIPH_INPLACE=1` keeps the sandbox but binds the real workspace read-write so run effects land live; `JAIPH_UNSAFE=true` runs on the host with no sandbox at all. Publish files a run produces with [artifacts](/how-to/artifacts). Editing a served source hot-reloads the workflow set (and the OpenAPI document) with no restart; runs already in flight keep running.

## Verification

```bash
# Health probe answers, unauthenticated.
curl -s http://127.0.0.1:5247/healthz | jq -e '.status == "ok"'

# A synchronous run round-trips its return value with a durable run dir.
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -d '{"name":"ok"}' \
  | jq -e '.status == "succeeded" and (.run_dir | length > 0)'

# The run listing is bounded: a hostile limit is clamped to at most 1000 records.
curl -s 'http://127.0.0.1:5247/v1/runs?limit=100000' \
  | jq -e '.limit == 1000 and (.runs | length) <= 1000'
```

Both `jq -e` checks exit `0` when the contract holds. The run's durable record is under `.jaiph/runs/…/run_summary.jsonl` (`run_dir` in the response), the same artifact layout as `jaiph run`.

## Related

- [CLI — `jaiph serve`](cli.md#jaiph-serve) — flag and endpoint reference.
- [Serve workflows as MCP tools](mcp.md) — the stdio sibling with the same exposure rules.
- [Run in a Docker sandbox](/how-to/sandbox-run) — the execution sandbox HTTP runs use.
- [Environment variables](env-vars.md) — `JAIPH_SERVE_TOKEN`, `JAIPH_SERVE_MAX_CONCURRENT`, the `JAIPH_SERVE_MAX_OUTPUT_BYTES` / `JAIPH_SERVE_RETAIN_RUNS` / `JAIPH_SERVE_RETAIN_AGE_SEC` memory bounds, and the sandbox controls.
