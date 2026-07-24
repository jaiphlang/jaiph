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

The run object is `{run_id, workflow, status, started_at, ended_at, exit_status, signal, result_text, run_dir}`. `result_text` is the same content an MCP client sees — the workflow's `return` value, or its failure narrative. **A workflow failure is not an HTTP error:** a failed run comes back `200`/`202` with `status: "failed"` and a `run dir:` pointer in `result_text`. Poll `GET /v1/runs/{id}` for an async run, list them with `GET /v1/runs` (newest first), and stop one with `POST /v1/runs/{id}/cancel`.

## 4. Use the Swagger UI

Open `http://127.0.0.1:5247/docs` in a browser to get a live form for every workflow. When a token is configured, paste it into the **Authorize** box (Swagger UI keeps it across reloads). The UI loads its assets from a pinned, SRI-verified CDN, so `/docs` needs internet access in the browser; air-gapped operators use `/openapi.json` with any locally-hosted renderer.

## 5. Require a token and expose the port

The token comes from the environment (never argv, which leaks into process listings). With it set, every `/v1/*` request must carry `Authorization: Bearer <token>`; `/healthz`, `/openapi.json`, and `/docs` stay open.

```bash
JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/v1/workflows -H 'authorization: Bearer secret' | jq
```

Binding a non-loopback `--host` **without** `JAIPH_SERVE_TOKEN` is a startup error — the server refuses to expose unauthenticated arbitrary shell. Cap simultaneous runs with `JAIPH_SERVE_MAX_CONCURRENT` (default `4`); requests beyond the cap get `429`. See [Environment variables](env-vars.md) for both.

Execution honors the same env-driven sandbox as [`jaiph run`](cli.md#jaiph-run) and [Run in a Docker sandbox](/how-to/sandbox-run): a Docker sandbox with an isolated workspace by default. `JAIPH_INPLACE=1` keeps the sandbox but binds the real workspace read-write so run effects land live; `JAIPH_UNSAFE=true` runs on the host with no sandbox at all. Publish files a run produces with [artifacts](/how-to/artifacts). Editing a served source hot-reloads the workflow set (and the OpenAPI document) with no restart; runs already in flight keep running.

## Verification

```bash
# Health probe answers, unauthenticated.
curl -s http://127.0.0.1:5247/healthz | jq -e '.status == "ok"'

# A synchronous run round-trips its return value with a durable run dir.
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -d '{"name":"ok"}' \
  | jq -e '.status == "succeeded" and (.run_dir | length > 0)'
```

Both `jq -e` checks exit `0` when the contract holds. The run's durable record is under `.jaiph/runs/…/run_summary.jsonl` (`run_dir` in the response), the same artifact layout as `jaiph run`.

## Related

- [CLI — `jaiph serve`](cli.md#jaiph-serve) — flag and endpoint reference.
- [Serve workflows as MCP tools](mcp.md) — the stdio sibling with the same exposure rules.
- [Run in a Docker sandbox](/how-to/sandbox-run) — the execution sandbox HTTP runs use.
- [Environment variables](env-vars.md) — `JAIPH_SERVE_TOKEN`, `JAIPH_SERVE_MAX_CONCURRENT`, and the sandbox controls.
