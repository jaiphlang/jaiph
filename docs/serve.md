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

Downloads stream from disk with backpressure — the server never buffers a complete artifact, so a multi-gigabyte file costs no server memory and a client disconnect closes the file immediately. To refuse oversized downloads outright, set `JAIPH_SERVE_MAX_ARTIFACT_BYTES` (default `0` = no cap); larger artifacts return `413`.

## 6. Use the Swagger UI

Open `http://127.0.0.1:5247/docs` in a browser to get a live form for every workflow. When a token is configured, paste it into the **Authorize** box (Swagger UI keeps it across reloads). The UI loads its assets from a pinned, SRI-verified CDN, so `/docs` needs internet access in the browser; air-gapped operators use `/openapi.json` with any locally-hosted renderer.

## 7. Require a token and expose the port

The token comes from the environment (never argv, which leaks into process listings). With it set, every `/v1/*` request must carry `Authorization: Bearer <token>`; `/healthz`, `/openapi.json`, and `/docs` stay open.

```bash
JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/v1/workflows -H 'authorization: Bearer secret' | jq
```

Binding a non-loopback `--host` **without** `JAIPH_SERVE_TOKEN` is a startup error — the server refuses to expose unauthenticated arbitrary shell. Cap simultaneous runs with `JAIPH_SERVE_MAX_CONCURRENT` (default `4`); requests beyond the cap get `429`. See [Environment variables](env-vars.md) for both.

## 8. Connect an MCP client over HTTP

The same process also speaks **MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)** at `POST /mcp` — the network sibling of [`jaiph mcp`](mcp.md) stdio. It exposes the **same tools** (identical [exposure rules](mcp.md#3-choose-which-workflows-are-exposed) and comment-derived descriptions), runs them through the **same run registry, concurrency cap, sandbox posture, and hot reload** as the REST API, and — when a token is set — sits behind the **same bearer auth** as `/v1/*`. A single deployment serves REST clients, browsers, and MCP agents at once; there is no second process.

```bash
# initialize → tools/list → tools/call, all as POST /mcp (one JSON-RPC message each).
curl -s -X POST http://127.0.0.1:5247/mcp -H 'content-type: application/json' \
  -H 'authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

curl -s -X POST http://127.0.0.1:5247/mcp -H 'content-type: application/json' \
  -H 'authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"world"}}}'
```

- **One JSON-RPC message per POST.** A **request** (`initialize`, `tools/list`, `tools/call`) returns its reply as a single `application/json` object. A **notification** (`notifications/initialized`, `notifications/cancelled`) returns `202 Accepted` with no body. `GET`/`DELETE /mcp` return `405` — this endpoint offers no server-initiated stream.
- **Progress streaming.** Send `Accept: text/event-stream` on a `tools/call` and include a `params._meta.progressToken` to receive the run's step boundaries as `notifications/progress` SSE frames, followed by the result frame — the same progress model as [`jaiph mcp`](mcp.md#7-stream-progress-and-cancel-a-long-call). Without that `Accept` header the call returns a single JSON result (progress is dropped).
- **Same run inspection.** Every `tools/call` is a first-class run: it appears in `GET /v1/runs`, streams at `GET /v1/runs/{id}/events`, and is cancellable with `POST /v1/runs/{id}/cancel` — the identical registry the REST endpoint populates. A client that hangs up a streaming call cancels the run (child process tree + Docker container torn down), the same as an MCP `notifications/cancelled`.
- **Auth.** With `JAIPH_SERVE_TOKEN` set, `POST /mcp` requires `Authorization: Bearer <token>` exactly like `/v1/*`; unauthenticated calls get `401`.

Point any Streamable-HTTP MCP client at `http(s)://<host>/mcp`. Use `jaiph mcp` for a co-located stdio client; use `jaiph serve` when the workflows must be reachable over the network by MCP and REST clients alike.

## 9. Bound memory over a long-lived server

The concurrency cap limits *active* children, not process memory. A long-lived server accumulates run state, so three bounds keep it from growing without limit — all overridable via [environment variables](env-vars.md):

- **Per-run output caps.** `JAIPH_SERVE_MAX_OUTPUT_BYTES` (default 1 MiB) caps collected stdout, stderr, log output, and the resident `result_text` independently. Output beyond a cap is dropped and marked with a deterministic `[jaiph: output truncated — exceeded the configured byte cap]` marker, so a run that emits gigabytes still costs bounded memory and returns a self-describing result.
- **Completed-run retention.** The in-memory run registry keeps at most `JAIPH_SERVE_RETAIN_RUNS` completed runs (default 500) and drops any completed run older than `JAIPH_SERVE_RETAIN_AGE_SEC` (default 24h). The oldest terminal records evict first; **active runs are never evicted.**
- **Bounded listing.** `GET /v1/runs` is paginated (`?limit=`, `?offset=`) with a default of 100 and a hard maximum of 1000 per page, so the endpoint can never return an unbounded response.

**Eviction is in-memory only.** Dropping a run from the registry does **not** delete its durable `.jaiph/runs/<run>/run_summary.jsonl` journal or published `artifacts/` — those persist on disk (via `JAIPH_RUNS_DIR`, an `emptyDir` or PVC under Kubernetes) and are **the operator's to prune**. Once a run is evicted its API endpoints (`GET /v1/runs/{id}`, `/events`, `/artifacts`) return `404`; read the durable artifacts from the filesystem instead.

## Restart-safe and retry-safe

The run registry is in memory, but it is **rebuilt from disk on startup** so a restart is not a data-loss event:

- **Durable run records.** When a run finishes, its public record (`run.json`) is written atomically beside its journal in the run directory. On startup `jaiph serve` scans `JAIPH_RUNS_DIR` and reloads every `run.json`, so `GET /v1/runs`, `GET /v1/runs/{id}`, `/events`, and `/artifacts` keep answering for terminal runs that completed before the restart.
- **Interrupted runs are reconciled.** A run that was still `running` when the process died has a journal but no `run.json`. On startup it is reconciled into the explicit terminal status **`interrupted`** — its real outcome is unknown (so it is neither `succeeded` nor `failed`), but it is **never reported as permanently `running`**. The reconciliation is persisted, so it is stable across further restarts.
- **Idempotent run creation.** Send an `Idempotency-Key` request header on `POST /v1/workflows/{name}/runs`. The key is scoped to the authenticated principal **and** the workflow. Repeating the request with the same key and identical arguments returns the **original** run (`200`) and starts nothing; reusing the key with **different** arguments is `409 E_IDEMPOTENCY_CONFLICT` and, again, spawns nothing — so a client that retries an expensive run after a network blip or a server restart never doubles it. The key→run mapping is stored in the durable record, so it survives a restart too. (An idempotency key is only remembered as long as its run is retained in the registry; once a run is evicted by the retention bounds above, its key is forgotten and a fresh request with that key starts a new run.)

```bash
# The same key + same args returns the original run and spawns nothing.
KEY=$(uuidgen)
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d '{"name":"ok"}' | jq .run_id
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d '{"name":"ok"}' | jq .run_id   # same id

# The same key + different args is a 409 conflict (spawns nothing).
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs' \
  -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d '{"name":"changed"}'   # 409
```

## Deployment topology

`jaiph serve` is a **single-replica** service. Its run registry, in-flight concurrency cap, and idempotency index are **per-process** — there is no shared store and no cross-replica coordination. Running two or more replicas behind a load balancer is **not supported**: each replica would see only its own runs (`GET /v1/runs/{id}` would `404` for a run another replica started), enforce `JAIPH_SERVE_MAX_CONCURRENT` independently, and keep a separate idempotency index (so the same `Idempotency-Key` could start one run per replica). Restart safety and retry safety hold **within a single long-lived process** that owns one `JAIPH_RUNS_DIR`.

Deploy exactly one replica. The [Kubernetes manifest](deploy.md#kubernetes) pins `replicas: 1` for this reason; scale vertically (CPU/memory and `JAIPH_SERVE_MAX_CONCURRENT`), not horizontally. Point `JAIPH_RUNS_DIR` at a durable volume (a PVC rather than an `emptyDir`) if runs and their idempotency keys must survive pod replacement, and keep the pod a `Recreate`-strategy single instance so a rollout hands the runs directory to exactly one successor.

Execution honors the same execution-policy contract as [`jaiph run`](cli.md#jaiph-run) and [Run in a Docker sandbox](/how-to/sandbox-run): a Docker sandbox with an isolated workspace by default. `--inplace` (`JAIPH_INPLACE=1`) keeps the sandbox but binds the real workspace read-write so run effects land live; `--unsafe` (`JAIPH_UNSAFE=true`) runs on the host with no sandbox at all. The two are mutually exclusive (`E_FLAG_CONFLICT` at startup), the posture is resolved and printed once at startup and applied to every run, and launching the server with the flag or env var is the consent (no interactive prompt) — see [Environment variables — Precedence](env-vars.md#precedence). Publish files a run produces with [artifacts](/how-to/artifacts). Editing a served source hot-reloads the workflow set (and the OpenAPI document) with no restart; runs already in flight keep running.

## Reverse-proxy and ingress requirements

`jaiph serve` speaks **plain HTTP** and holds long-lived streaming connections (SSE at `GET /v1/runs/{id}/events`, and MCP progress at `POST /mcp` with `Accept: text/event-stream`). Front it with a reverse proxy / ingress that is configured for streaming and TLS, not just request/response:

- **Disable response buffering on the streaming routes.** A proxy that buffers the whole response defeats live streaming — clients see nothing until the run ends. nginx: `proxy_buffering off;` (or the `X-Accel-Buffering: no` header) on `/v1/runs/*/events` and `/mcp`. Envoy/Ingress: disable response buffering for those paths. The server already sends `Cache-Control: no-cache` and a `:ka` keep-alive comment every 15 s on SSE to keep intermediaries from idling the connection out.
- **Raise read/idle timeouts to cover the longest run.** A `tools/call` or `?wait=true` REST run blocks the connection until the workflow finishes, and an SSE follow stays open for the whole run. Set the proxy's upstream read timeout (nginx `proxy_read_timeout`, cloud LB idle timeout) above your slowest workflow, or those clients get cut off mid-run. `HTTP/1.1` (not buffered `HTTP/2` translation that coalesces) on the streaming hops.
- **Terminate TLS at the proxy.** The process serves cleartext; put HTTPS at the ingress/gateway (cert-manager, a cloud LB, or a mesh) in front of it and keep the app port private (loopback or a `ClusterIP` Service — see [Deploy](deploy.md)). Never expose the token-guarded API to the internet without TLS: the bearer token would travel in the clear.
- **Preserve and require authentication end to end.** Forward the `Authorization` header unchanged (do not strip it), and terminate untrusted traffic at the proxy only if the proxy itself authenticates. `jaiph`'s own bearer check guards `/v1/*` and `/mcp`; `/healthz`, `/openapi.json`, and `/docs` stay open for probes and discovery. If the proxy adds its own auth, keep `JAIPH_SERVE_TOKEN` set anyway so a proxy misconfiguration can never expose unauthenticated shell.

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
- [Serve workflows as MCP tools](mcp.md) — the stdio sibling with the same exposure rules; `POST /mcp` here is its network transport.
- [Run in a Docker sandbox](/how-to/sandbox-run) — the execution sandbox HTTP runs use.
- [Environment variables](env-vars.md) — `JAIPH_SERVE_TOKEN`, `JAIPH_SERVE_MAX_CONCURRENT`, the `JAIPH_SERVE_MAX_OUTPUT_BYTES` / `JAIPH_SERVE_RETAIN_RUNS` / `JAIPH_SERVE_RETAIN_AGE_SEC` memory bounds, and the sandbox controls.
