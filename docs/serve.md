---
title: Serve workflows over HTTP
permalink: /how-to/serve
diataxis: how-to
---

# Serve workflows over HTTP

This guide turns a `.jh` file into an HTTP API. `jaiph serve ./tools.jh` exposes the file's workflows as endpoints, publishes a machine-readable [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document, and serves a Swagger UI you can open in a browser. Any HTTP client can invoke the tested workflows and inspect their runs without an MCP client or a local jaiph install. For example, a CI job, a Kubernetes deployment, another service, or a person with a browser can all reach the same endpoints.

It reuses the same compile-time validation, sandboxed execution, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run), and the same exposure rules as [`jaiph mcp`](mcp.md). `jaiph mcp` binds the server to a stdio parent on the same machine, and `jaiph serve` instead makes the workflows reachable over the network.

> **Security.** An exposed workflow is arbitrary shell that anyone who can reach the port can run, and that is the point of serving it. A request argument that binds to a workflow parameter is shell-quoted before it reaches any shell step, so a caller cannot use an argument value to inject extra shell commands, though the caller can still run whatever the exposed workflow itself does. When a token is set, the caller must also hold the token. With no token or OIDC the server has no auth at all, so it refuses to start unless you pass `--allow-anonymous`, which is for a single-user workstation only — on a shared host any local user could invoke the workflows (see [Authenticate and authorize](#7-authenticate-and-authorize)). For anything beyond a single-user loopback, configure authentication, put the server behind a reverse proxy or ingress that terminates TLS, and treat the run directory as sensitive. The process itself speaks plain HTTP. For authentication, use a static `JAIPH_SERVE_TOKEN` for a single operator, or OIDC/JWT for multiple users (see [Authenticate and authorize](#7-authenticate-and-authorize)).

## Prerequisites

- A `.jh` file with at least one workflow.
- Agent credentials for any exposed workflow that uses `prompt`. See [Authenticate agent backends](agent-auth.md). Set them on the host. In Docker mode the backend's credential keys are forwarded through the env allowlist. Forward any other host variable a workflow needs with `--env`, using the same rules as `jaiph run`.

## 1. Start the server

```bash
jaiph serve ./tools.jh
# jaiph serve: listening on http://127.0.0.1:5247 — API docs at http://127.0.0.1:5247/docs, MCP at http://127.0.0.1:5247/mcp (2 workflow(s))
```

The defaults are `--host 127.0.0.1` and `--port 5247`. All logs go to stderr. Startup validates the file exactly like [`jaiph mcp`](cli.md#jaiph-mcp). A compile error prints a `file:line:col CODE message` diagnostic to stderr and exits `1`.

## 2. Discover the workflows

```bash
curl -s http://127.0.0.1:5247/v1/workflows | jq
```

`GET /openapi.json` returns the full OpenAPI 3.1 document, with one path per workflow. Each path carries the workflow's `#`-comment description and its parameters as a JSON request-body schema. `GET /healthz` is a liveness and readiness probe that needs no authentication.

## 3. Invoke a workflow

A run is a durable resource. `POST /v1/workflows/{name}/runs` starts one. The request body is a JSON object of the workflow's parameters, and every value is a string.

```bash
# Async: 202 + a Location header pointing at the run resource.
curl -si -X POST http://127.0.0.1:5247/v1/workflows/greet/runs \
  -H 'content-type: application/json' -d '{"name":"world"}'

# Synchronous: block until the run is terminal, then return the final object.
curl -s -X POST 'http://127.0.0.1:5247/v1/workflows/greet/runs?wait=true' \
  -H 'content-type: application/json' -d '{"name":"world"}' | jq
```

The run object has these fields: `run_id`, `workflow`, `status`, `started_at`, `ended_at`, `exit_status`, `signal`, `result_text`, `run_dir`, `principal`, and `correlation_id`. `principal` is the audit subject that created the run, which is `anonymous` in anonymous mode (`--allow-anonymous`) and `operator` under a static token. `correlation_id` is the request id, taken from an `X-Correlation-Id` or `X-Request-Id` header, or a generated UUID. See [Authenticate and authorize](#7-authenticate-and-authorize) for both. A run reconstructed after a restart can carry `null` for either field.

`result_text` is the same content an MCP client sees, which is the workflow's `return` value or its failure narrative. A failure narrative is credential-redacted the same way as the event journal, so the value of any env var whose name looks like a credential becomes `[REDACTED]`. The rule now covers many common secret names, e.g. `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, and `*_PRIVATE_KEY`, and it also redacts the base64, hex, and URL-encoded forms of each value. See [Architecture — Secret redaction](architecture.md#secret-redaction) for the full rule and its limits. The `return` value of a successful run is intended API output, so it is returned verbatim.

A workflow failure is not an HTTP error. A failed run comes back `200` or `202` with `status: "failed"` and a `run dir:` pointer in `result_text`. Poll `GET /v1/runs/{id}` for an async run. List runs with `GET /v1/runs`, which returns them newest first and paginated. `?limit=` defaults to 100 and is clamped to 1000, and `?offset=` skips that many records. The listing response carries `{runs, total, limit, offset}`. Stop a run with `POST /v1/runs/{id}/cancel`.

## 4. Watch a run as it executes

`GET /v1/runs/{id}/events` streams the run's durable event journal (`run_summary.jsonl`), which is the same timeline the CLI builds its progress tree from. It has two modes.

```bash
# Snapshot (default): the whole journal as newline-delimited JSON, then close.
curl -s http://127.0.0.1:5247/v1/runs/$ID/events

# Live: Server-Sent Events. Replays the journal so far, then follows it as the
# run appends, and closes with an `event: end` when the run is terminal.
curl -sN -H 'accept: text/event-stream' http://127.0.0.1:5247/v1/runs/$ID/events
```

Each SSE message is a `data:` line that carries one raw journal line, such as `WORKFLOW_START`, `STEP_START`, `STEP_END`, `LOG*`, `PROMPT_*`, or `WORKFLOW_END`. A `:ka` comment every 15 seconds keeps proxies from idling the connection out. Connect while the run is still going to watch it step by step, or connect after it finishes for a full replay followed by an immediate `event: end`. Add `-H 'authorization: Bearer <token>'` when a token is set. The `-N` flag on `curl` disables buffering, so events surface as they arrive.

The default snapshot mode verifies the run's keyed integrity chain before it returns the body. When the chain does not verify, because the journal was rewritten, truncated, or forged, the snapshot request fails with `409 E_TAMPERED` and serves no timeline. A run with no persisted key, such as an older run written before the chain was keyed, cannot be verified and is never blocked. See [Architecture — Keyed hash chain](architecture.md#hash-chain) for the format and for how the key stays out of the workflow.

> **Security.** The journal is served verbatim, so the only redaction is the one `jaiph` applies when it writes the journal. The value of any env var whose name looks like a credential becomes `[REDACTED]`, along with its base64, hex, and URL-encoded forms (see [Architecture — Secret redaction](architecture.md#secret-redaction)). Redaction is literal-substring replacement, so it does not catch a secret that has been transformed some other way, such as split across output chunks or embedded inside an opaque connection string. The raw per-step capture files (`NNNNNN-*.out` and `.err`) are never exposed by any endpoint. Only the redacted journal and the files a workflow publishes are reachable over HTTP.

## 5. Download a run's artifacts

A workflow can publish files to `$JAIPH_ARTIFACTS_DIR` (see [artifacts](artifacts.md)). You can list and download them.

```bash
# List published files: [{path, size, mtime}, ...] (empty when the run made none).
curl -s http://127.0.0.1:5247/v1/runs/$ID/artifacts | jq

# Download one by its relative path (application/octet-stream).
curl -s http://127.0.0.1:5247/v1/runs/$ID/artifacts/report.txt -o report.txt
```

The download path is resolved strictly inside the run's `artifacts/` directory and is safe against path traversal. A `..` segment, an absolute path, or a symlink pointing outside the directory all return `404` without touching the target file.

Downloads stream from disk with backpressure. The server never buffers a complete artifact, so a file of several gigabytes costs no server memory, and a client disconnect closes the file immediately. To refuse oversized downloads, set `JAIPH_SERVE_MAX_ARTIFACT_BYTES`. The default is `0`, which means no cap. A larger artifact returns `413`.

## 6. Use the Swagger UI

Open `http://127.0.0.1:5247/docs` in a browser to get a live form for every workflow. When a token is configured, paste it into the Authorize box, and Swagger UI keeps it across reloads. `/docs` is self-contained and does not require browser internet access. The pinned `swagger-ui-dist` assets are embedded in the jaiph binary and served from same-origin `/docs/*` paths, so the browser never fetches anything from a third-party host. Each asset tag carries a Subresource Integrity hash computed from the embedded bytes, so a proxy or cache that changes an asset in flight is rejected. Because everything loads from the same origin, `/docs` renders and can invoke workflows on an air-gapped network, and behind a Content-Security-Policy that blocks external hosts. `/openapi.json` stays available for any other renderer.

## 7. Authenticate and authorize

`jaiph serve` has two production authentication modes, plus an anonymous mode that is an explicit opt-in for a single-user workstation. Credentials come from the environment, never from argv, because argv leaks into process listings. In every mode, `/healthz` stays open and needs no credentials. `/docs` and `/openapi.json` also stay open, unless `JAIPH_SERVE_EXPOSE_DOCS=false` hides them behind a `404`.

**Static single-operator token.** `JAIPH_SERVE_TOKEN` is a shared secret required on every `/v1/*` and `/mcp` request, sent as `Authorization: Bearer <token>` and compared in constant time. It is a fail-closed gate for one operator. There is no per-user identity, no revocation, and no per-action authorization, so the one operator holds every capability and sees every run. Use it for a single trusted caller, not for several people in a company. The token stays on the host and never crosses into a workflow sandbox, so a workflow the server runs cannot read it and use it to call the API back as the operator.

```bash
JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/v1/workflows -H 'authorization: Bearer secret' | jq
```

**OIDC/JWT for multiple users.** Set `JAIPH_SERVE_OIDC_ISSUER` and `JAIPH_SERVE_OIDC_AUDIENCE`. OIDC takes precedence over the static token when both are set. Bearer tokens are verified against the issuer's JWKS, which is the set of public signing keys. Jaiph discovers the key set from `<issuer>/.well-known/openid-configuration`, or you can set `JAIPH_SERVE_OIDC_JWKS_URI` explicitly. A maintained JWT library (`jose`) does the cryptographic checks: the signature, the `exp` and `nbf` times, the `aud` and `iss` claims, and key selection by `kid`. Jaiph also pins an explicit allowlist of asymmetric signing algorithms, covering the RSA, ECDSA, and EdDSA families that standard OIDC providers sign with, and it excludes symmetric algorithms, `alg: none`, and the non-recommended secp256k1 curve (`ES256K`). A token whose header names an algorithm outside the allowlist is rejected even when its signing key is in the JWKS, so a future key-type or JWKS change cannot make an algorithm-confusion or `alg: none` forgery reachable. A verification failure is a `401`, with `E_TOKEN_EXPIRED` for an expired token and `E_TOKEN_INVALID` for a bad audience, issuer, key, signature, or signing algorithm. An unreachable identity provider is a `503` (`E_AUTH_UNAVAILABLE`).

Each token is authorized by three OAuth scopes. Request them in the `scope` claim (or the `scp` claim):

| Scope | Grants |
| --- | --- |
| `jaiph:invoke` | `POST /v1/workflows/{name}/runs` and MCP `tools/call` |
| `jaiph:inspect` | `GET /v1/workflows`, `/v1/runs`, a run, its events and artifacts; MCP `tools/list` |
| `jaiph:cancel` | `POST /v1/runs/{id}/cancel` |

A missing capability is a `403` (`E_FORBIDDEN`). A principal is identified by the token `sub`, falling back to `client_id` for `sub`-less machine tokens (OAuth2 client-credentials); a verified token carrying neither is rejected `401 E_UNAUTHORIZED` rather than sharing one identity, so distinct callers never share a run-visibility bucket or idempotency namespace. A principal may inspect or cancel only the runs it created. Another principal's run returns `404`, so it looks the same as a run that does not exist. The authenticated `sub` and the request's correlation id are attached to three places: each run's metadata (`principal` and `correlation_id` on the run object), the invoke and cancel audit log lines, and the OTLP resource attributes and Sentry tags. The correlation id comes from an `X-Correlation-Id` or `X-Request-Id` header, or a generated UUID when neither is present. Jaiph never attaches the token or a claim value.

```bash
JAIPH_SERVE_OIDC_ISSUER=https://issuer.example \
JAIPH_SERVE_OIDC_AUDIENCE=jaiph-serve \
  jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh
curl -s http://host:8080/v1/runs -H "authorization: Bearer $JWT" | jq
```

**Anonymous mode is single-user-workstation only.** With no `JAIPH_SERVE_TOKEN` and no OIDC configured, the server has no authentication: every `/v1/*` and `/mcp` request is authorized as an anonymous principal that holds every capability over every run. Loopback is a boundary against the network, not against other local users, so on a shared or multi-user host any other local user or process can invoke the exposed workflows and read every run's artifacts. Because of that, anonymous mode is not the default — it is refused at startup unless you pass `--allow-anonymous` to opt in explicitly. Even with the flag, a non-loopback bind stays a startup error; the flag only permits a loopback bind. When you do pass it, the server prints a prominent startup warning that it is open to all local principals. Use anonymous mode only on a single-user workstation; any shared host must set `JAIPH_SERVE_TOKEN` or configure OIDC.

Binding a non-loopback `--host` with no authentication, meaning neither the token nor OIDC, is a startup error, and `--allow-anonymous` does not lift it. The server refuses to expose unauthenticated arbitrary shell over the network. Cap simultaneous runs with `JAIPH_SERVE_MAX_CONCURRENT`, which defaults to `4`. A request beyond the cap gets `429`. See [Environment variables](env-vars.md) for all of these.

## 8. Connect an MCP client over HTTP

The same process also speaks MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) at `POST /mcp`, which is the network sibling of [`jaiph mcp`](mcp.md) stdio. It exposes the same tools, with identical [exposure rules](mcp.md#3-choose-which-workflows-are-exposed) and comment-derived descriptions. It runs them through the same run registry, concurrency cap, sandbox posture, and hot reload as the REST API. When a token is set, it sits behind the same bearer authentication as `/v1/*`. A single deployment serves REST clients, browsers, and MCP agents at once, with no second process.

```bash
# One JSON-RPC message per POST: initialize, then tools/list, then tools/call.
curl -s -X POST http://127.0.0.1:5247/mcp -H 'content-type: application/json' \
  -H 'authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

curl -s -X POST http://127.0.0.1:5247/mcp -H 'content-type: application/json' \
  -H 'authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"world"}}}'
```

- **One JSON-RPC message per POST.** A request (`initialize`, `tools/list`, or `tools/call`) returns its reply as a single `application/json` object. A notification (`notifications/initialized` or `notifications/cancelled`) returns `202 Accepted` with no body. `GET` and `DELETE` on `/mcp` return `405`, because this endpoint offers no server-initiated stream.
- **Progress streaming.** Send `Accept: text/event-stream` on a `tools/call` and include a `params._meta.progressToken`. You then receive the run's step boundaries as `notifications/progress` SSE frames, followed by the result frame. It uses the same progress model as [`jaiph mcp`](mcp.md#7-stream-progress-and-cancel-a-long-call). Without that `Accept` header, the call returns a single JSON result and progress is dropped.
- **Same run inspection.** Every `tools/call` is a run like any other. It appears in `GET /v1/runs`, streams at `GET /v1/runs/{id}/events`, and can be cancelled with `POST /v1/runs/{id}/cancel`, all in the same registry the REST endpoint populates. A client that hangs up a streaming call cancels the run, which tears down the child process tree and the Docker container, the same as an MCP `notifications/cancelled`.
- **Authentication.** `POST /mcp` sits behind the same authentication boundary as `/v1/*` (see [Authenticate and authorize](#7-authenticate-and-authorize)). Every request needs a bearer token, either static or OIDC/JWT, and an unauthenticated call gets `401`. Capabilities apply per method, so `tools/call` needs `invoke` and `tools/list` needs `inspect`. A principal without the needed scope gets a JSON-RPC error and nothing spawns, rather than an HTTP `403`. The authenticated principal and correlation id are attached to every run an MCP `tools/call` creates, exactly as for a REST run.

Point any Streamable HTTP MCP client at `http(s)://<host>/mcp`. Use `jaiph mcp` for a stdio client on the same machine, and use `jaiph serve` when MCP and REST clients both need to reach the workflows over the network.

## 9. Bound memory over a long-lived server

The concurrency cap limits active children, not process memory. A long-lived server keeps accumulating run state, so three bounds stop it from growing without limit. You can override all of them through [environment variables](env-vars.md).

- **Per-run output caps.** `JAIPH_SERVE_MAX_OUTPUT_BYTES` (default 1 MiB) caps collected stdout, stderr, log output, and the resident `result_text`, each independently. Output beyond a cap is dropped and replaced with a fixed `[jaiph: output truncated — exceeded the configured byte cap]` marker. A run that emits gigabytes therefore still costs bounded memory and returns a result that describes what happened.
- **Completed-run retention.** The in-memory run registry keeps at most `JAIPH_SERVE_RETAIN_RUNS` completed runs (default 500), and it drops any completed run older than `JAIPH_SERVE_RETAIN_AGE_SEC` (default 24 hours). The oldest terminal records evict first, and active runs are never evicted.
- **Bounded listing.** `GET /v1/runs` is paginated with `?limit=` and `?offset=`. The default page is 100 and the hard maximum is 1000, so the endpoint can never return an unbounded response.

Eviction is in-memory only. Dropping a run from the registry does not delete its durable `run_summary.jsonl` journal or its published `artifacts/`. Both persist on disk under `JAIPH_RUNS_DIR`, which is an `emptyDir` or a PVC under Kubernetes, and pruning them is the operator's job. Once a run is evicted, its API endpoints (`GET /v1/runs/{id}`, `/events`, and `/artifacts`) return `404`, so read the durable artifacts from the filesystem instead.

## Restart-safe and retry-safe

The run registry is in memory, but `jaiph serve` rebuilds it from disk on startup, so a restart does not lose run data.

- **Durable run records.** When a run finishes, `jaiph serve` writes its public record (`run.json`) atomically beside its journal in the run directory. On startup `jaiph serve` scans `JAIPH_RUNS_DIR` and reloads every `run.json`, so `GET /v1/runs`, `GET /v1/runs/{id}`, `/events`, and `/artifacts` keep answering for terminal runs that finished before the restart. As it reloads each run, `jaiph serve` verifies the run's keyed integrity chain. A run whose chain does not verify is loaded with status `failed` and a result that says the journal failed integrity verification, so a rewritten or truncated journal is surfaced as a failure rather than trusted. A run with no persisted key cannot be verified and is loaded unchanged. See [Architecture — Keyed hash chain](architecture.md#hash-chain).
- **Interrupted runs are reconciled.** A run that was still `running` when the process died has a journal but no `run.json`. On startup `jaiph serve` reconciles it into the explicit terminal status `interrupted`. Its real outcome is unknown, so it is neither `succeeded` nor `failed`, but it is never reported as permanently `running`. Jaiph persists the reconciliation, so it stays stable across further restarts.
- **Idempotent run creation.** Send an `Idempotency-Key` request header on `POST /v1/workflows/{name}/runs`. The key is scoped to the authenticated principal and the workflow. Repeating the request with the same key and identical arguments returns the original run (`200`) and starts nothing. Reusing the key with different arguments is a `409 E_IDEMPOTENCY_CONFLICT` and, again, spawns nothing. A client that retries an expensive run after a network blip or a server restart therefore never doubles it. The key and run mapping is stored in the durable record, so it survives a restart too. An idempotency key is remembered only as long as its run is retained in the registry. Once the retention bounds above evict a run, its key is forgotten, and a fresh request with that key starts a new run.

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

`jaiph serve` is a single-replica service. Its run registry, in-flight concurrency cap, and idempotency index are per-process, with no shared store and no coordination between replicas. Running two or more replicas behind a load balancer is not supported. Each replica would see only its own runs, so `GET /v1/runs/{id}` would return `404` for a run another replica started. Each replica would also enforce `JAIPH_SERVE_MAX_CONCURRENT` on its own and keep a separate idempotency index, so the same `Idempotency-Key` could start one run per replica. Restart safety and retry safety hold within a single long-lived process that owns one `JAIPH_RUNS_DIR`.

Deploy exactly one replica. The [Kubernetes manifest](deploy.md#kubernetes) pins `replicas: 1` for this reason. Scale it vertically, with more CPU and memory and a higher `JAIPH_SERVE_MAX_CONCURRENT`, rather than horizontally. Point `JAIPH_RUNS_DIR` at a durable volume, a PVC rather than an `emptyDir`, if runs and their idempotency keys must survive pod replacement. Keep the pod a single instance with the `Recreate` strategy, so a rollout hands the runs directory to exactly one successor.

Execution follows the same execution-policy contract as [`jaiph run`](cli.md#jaiph-run) and [Run in a Docker sandbox](sandbox-run.md). By default every run uses a Docker sandbox with an isolated workspace. `--inplace` (`JAIPH_INPLACE=1`) keeps the sandbox but binds the real workspace read-write, so a run's effects land live. `--unsafe` runs on the host with no sandbox at all. The two flags are mutually exclusive and conflict with `E_FLAG_CONFLICT` at startup. `jaiph serve` resolves the posture once at startup, prints it, and applies it to every run. For the default sandbox and inplace, launching the server with the flag or env var is the consent, so there is no interactive prompt. Unsafe host-only additionally requires the explicit flag `--unsafe` (or `--yes`): an ambient `JAIPH_UNSAFE=true` inherited from the environment without that flag is refused at startup (`E_UNSAFE_NO_CONSENT`, skipped inside a container where the container is the sandbox), and when consent is given the server prints a prominent SANDBOXING DISABLED banner. See [Environment variables, Precedence](env-vars.md#precedence) for the details. Publish the files a run produces with [artifacts](artifacts.md). Editing a served source hot-reloads the workflow set and the OpenAPI document with no restart, and runs already in flight keep running.

## Reverse-proxy and ingress requirements

`jaiph serve` speaks plain HTTP and holds long-lived streaming connections, both the SSE stream at `GET /v1/runs/{id}/events` and MCP progress at `POST /mcp` with `Accept: text/event-stream`. Front it with a reverse proxy or ingress that is configured for streaming and TLS, not only for request and response:

- **Disable response buffering on the streaming routes.** A proxy that buffers the whole response defeats live streaming, because clients see nothing until the run ends. On nginx, set `proxy_buffering off;` (or the `X-Accel-Buffering: no` header) on `/v1/runs/*/events` and `/mcp`. On Envoy or another ingress, disable response buffering for those paths. The server already sends `Cache-Control: no-cache` and a `:ka` keep-alive comment every 15 seconds on SSE, to keep intermediaries from idling the connection out.
- **Raise read and idle timeouts to cover the longest run.** A `tools/call` or a `?wait=true` REST run blocks the connection until the workflow finishes, and an SSE follow stays open for the whole run. Set the proxy's upstream read timeout above your slowest workflow (nginx `proxy_read_timeout`, or a cloud load balancer's idle timeout), or those clients get cut off mid-run. Use `HTTP/1.1` on the streaming hops, rather than a buffered `HTTP/2` translation that coalesces frames.
- **Terminate TLS at the proxy.** The process serves cleartext, so put HTTPS at the ingress or gateway in front of it, using cert-manager, a cloud load balancer, or a service mesh. Keep the app port private, on loopback or a `ClusterIP` Service (see [Deploy](deploy.md)). Never expose the token-guarded API to the internet without TLS, because the bearer token would travel in the clear.
- **Preserve and require authentication end to end.** Forward the `Authorization` header unchanged, and do not strip it. Terminate untrusted traffic at the proxy only if the proxy itself authenticates. Jaiph's own bearer check guards `/v1/*` and `/mcp`, while `/healthz`, `/openapi.json`, and `/docs` stay open for probes and discovery. If the proxy adds its own authentication, keep `JAIPH_SERVE_TOKEN` set anyway, so a proxy misconfiguration can never expose unauthenticated shell.

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

Each `jq -e` check exits `0` when the contract holds. The run's durable record is under `.jaiph/runs/…/run_summary.jsonl`, whose path is `run_dir` in the response, and it uses the same artifact layout as `jaiph run`.

## Related

- [CLI reference for `jaiph serve`](cli.md#jaiph-serve): the flag and endpoint reference.
- [Serve workflows as MCP tools](mcp.md): the stdio sibling with the same exposure rules. `POST /mcp` here is its network transport.
- [Run in a Docker sandbox](sandbox-run.md): the execution sandbox HTTP runs use.
- [Environment variables](env-vars.md): `JAIPH_SERVE_TOKEN`, `JAIPH_SERVE_MAX_CONCURRENT`, the `JAIPH_SERVE_MAX_OUTPUT_BYTES`, `JAIPH_SERVE_RETAIN_RUNS`, and `JAIPH_SERVE_RETAIN_AGE_SEC` memory bounds, and the sandbox controls.
