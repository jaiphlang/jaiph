---
title: Serve defs over HTTP
permalink: /how-to/serve
diataxis: how-to
---

# Serve defs over HTTP

Turn a `.jh` file into an HTTP API. `jaiph serve ./tools.jh` exposes the file's defs as endpoints, publishes an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document, and serves a Swagger UI, so any HTTP client — a CI job, another service, or a browser — can invoke the tested defs and inspect their runs. It reuses the same validation, host execution, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run) and the same exposure rules as [`jaiph mcp`](mcp.md); the stdio sibling binds to a parent process, while `jaiph serve` reaches the defs over the network.

> **Security.** An exposed def is arbitrary shell that anyone who can reach the port can run. With no token or OIDC the server has no auth and refuses to start unless you pass `--allow-anonymous`. For anything beyond a single operator, configure auth (step 5), front the server with a TLS-terminating reverse proxy (step 7), and treat the run directory as sensitive.

## Prerequisites

- A `.jh` file with at least one exported def.
- Agent credentials for any exposed def that uses `prompt` — see [Authenticate agent backends](agent-auth.md).

## 1. Start the server

```bash
jaiph serve ./tools.jh
# jaiph serve: listening on http://127.0.0.1:5247 — API docs at /docs, MCP at /mcp (2 def(s))
```

The defaults are `--host 127.0.0.1` and `--port 5247`; all logs go to stderr. Startup validates the file exactly like `jaiph mcp`, and a compile error exits `1`. For every flag and endpoint, see [the `jaiph serve` reference](cli.md#jaiph-serve).

## 2. Discover and invoke a def

`POST /{name}` starts a run from a JSON object of the def's string parameters; see [the `jaiph serve` reference](cli.md#jaiph-serve) for the full endpoint list, their capabilities, and the run resource:

```bash
# Async: 202 + a Location header pointing at the run resource.
curl -si -X POST http://127.0.0.1:5247/greet -H 'content-type: application/json' -d '{"name":"world"}'

# Synchronous: block until the run is terminal, then return the final object.
curl -s -X POST 'http://127.0.0.1:5247/greet?wait=true' -H 'content-type: application/json' -d '{"name":"world"}' | jq
```

The run object's `result_text` is the same content an MCP client sees — the def's `return` value or its credential-redacted failure narrative (see [Architecture — Secret redaction](architecture.md#secret-redaction)). A def failure is not an HTTP error: a failed run comes back `200`/`202` with `status: "failed"`.

## 3. Watch a run and download artifacts

`GET /runs/{id}/events` streams the run's durable journal (`run_summary.jsonl`) as a one-shot snapshot or, with `accept: text/event-stream`, as live Server-Sent Events; a def's published [artifacts](artifacts.md) stream from `GET /runs/{id}/artifacts`. See [the `jaiph serve` reference](cli.md#jaiph-serve) for the streaming, journal-integrity, and path-traversal contract.

```bash
curl -sN -H 'accept: text/event-stream' http://127.0.0.1:5247/runs/$ID/events
```

## 4. Use the Swagger UI

Open `http://127.0.0.1:5247/docs` for a live form for every def; the root `/` redirects there. The pinned `swagger-ui-dist` assets are embedded in the binary and served same-origin with Subresource Integrity hashes, so `/docs` renders on an air-gapped network with no third-party fetch. When a token is set, paste it into the Authorize box.

## 5. Authenticate and authorize {#7-authenticate-and-authorize}

Credentials come from the environment, never argv. `jaiph serve` supports a static token, OIDC/JWT, and an explicit `--allow-anonymous` opt-in; see [the `jaiph serve` reference](cli.md#jaiph-serve) for the auth modes, scopes, and open endpoints, and [Environment variables](env-vars.md) for every name.

```bash
JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/defs -H 'authorization: Bearer secret' | jq
```

## 6. Connect an MCP client over HTTP

The same process speaks MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) at `POST /mcp`, the network sibling of [`jaiph mcp`](mcp.md) with the same exposure rules, run registry, hot reload, and bearer auth. One JSON-RPC message per POST; a request returns a single `application/json` reply and a notification returns `202`. Send `Accept: text/event-stream` on a `tools/call` with a `params._meta.progressToken` to receive [the same progress frames as stdio](mcp.md#7-stream-progress-and-cancel-a-long-call), followed by the result.

```bash
curl -s -X POST http://127.0.0.1:5247/mcp -H 'content-type: application/json' -H 'authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"world"}}}'
```

## 7. Deploy behind a proxy {#deployment-topology}

`jaiph serve` is a single-replica service: its run registry, concurrency cap, and idempotency index are per-process, so pin `replicas: 1` and scale vertically (see the [Kubernetes manifest](deploy.md#kubernetes)). It rebuilds the registry from `JAIPH_RUNS_DIR` on startup, so a restart keeps terminal runs and their `Idempotency-Key` mappings; point that directory at a durable volume. It speaks plain HTTP and holds long-lived streams, so front it with a proxy that disables response buffering on `/runs/*/events` and `/mcp`, raises read timeouts above the slowest def, terminates TLS, and forwards `Authorization` unchanged. Memory over a long-lived server is bounded by the `JAIPH_SERVE_*` output, retention, and concurrency caps in [Environment variables](env-vars.md). Execution follows [`jaiph run`](cli.md#jaiph-run): every run executes on the host, so wrap it in a container for isolation (see [Deploy jaiph](deploy.md)).
{:#9-bound-memory-over-a-long-lived-server}

## Verification

```bash
# Health probe answers, unauthenticated.
curl -s http://127.0.0.1:5247/healthz | jq -e '.status == "ok"'

# A synchronous run round-trips its return value with a durable run dir.
curl -s -X POST 'http://127.0.0.1:5247/greet?wait=true' -H 'content-type: application/json' -d '{"name":"ok"}' | jq -e '.status == "succeeded" and (.run_dir | length > 0)'

# The run listing is bounded: a hostile limit is clamped to at most 1000 records.
curl -s 'http://127.0.0.1:5247/runs?limit=100000' | jq -e '.limit == 1000 and (.runs | length) <= 1000'
```

Each `jq -e` check exits `0` when the contract holds; `run_dir` points at the run's directory under `.jaiph/runs/…/`.

## Related

- [CLI reference for `jaiph serve`](cli.md#jaiph-serve): the flag and endpoint reference.
- [MCP server in 30 seconds](mcp.md): the stdio sibling with the same exposure rules.
- [Deploy jaiph](deploy.md): wrap jaiph in an image or pod for outer isolation.
- [Environment variables](env-vars.md): the `JAIPH_SERVE_*` tokens and memory bounds.
