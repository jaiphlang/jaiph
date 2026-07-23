# serve — design doc

*`jaiph serve <file.jh>` serves the file's workflows as an HTTP API with a generated OpenAPI 3.1 document and an embedded Swagger UI. Anything that speaks HTTP — a CI job, a Kubernetes deployment, another service, a human with a browser — can invoke tested workflows and inspect their runs, without an MCP client or a local jaiph install.*

**Status:** design — ready for implementation (tasks queued in QUEUE.md)
**Date (UTC):** 2026-07-23

## Problem

`jaiph mcp` made workflows callable by agents, but stdio binds the server to a parent process on the same machine. External feedback (2026-07-23): a company cannot depend on "a local machine + docker" — workflows must be deployable (docker/kubernetes), invokable over the network, and inspectable through an API, ideally with a UI on top. HTTP + OpenAPI is the lingua franca: it turns the existing runtime image into a deployable service, and Swagger UI doubles as the first inspection/invocation UI at near-zero cost.

Goals, in order:

1. **Workflows as HTTP endpoints** — the same exposure rules as MCP (`deriveTools`): `export workflow` narrows, channel route targets are excluded, descriptions come from `#` comments.
2. **Self-describing** — `GET /openapi.json` and `GET /docs` (Swagger UI). The OpenAPI document is generated from the same tool specs the endpoints enforce, so schema and behavior cannot drift.
3. **Runs as resources** — `POST` creates a durable run under `.jaiph/runs/`; `GET` inspects status, result, the event journal (live-streamable), and artifacts.
4. **Zero runtime dependencies** — hand-rolled on `node:http`, exactly as the MCP JSON-RPC surface was hand-rolled instead of pulling in an SDK.
5. **Reuse the execution layer** — `callWorkflow` (`src/cli/mcp/call.ts`) with unchanged semantics: same env-driven sandbox selection, artifacts, credential preflight, and `--env` passthrough as `jaiph run`/`jaiph mcp`.

## CLI surface

```
jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>
```

- Defaults: `--host 127.0.0.1`, `--port 5247` (J-A-I-P on a phone keypad).
- `--workspace` and repeatable `--env` behave exactly as in `jaiph mcp` (`parseArgs`/`resolveEnvPairs`).
- Startup validation identical to `jaiph mcp`: `loadModuleGraph` + `collectDiagnostics`; diagnostics → stderr, exit 1.
- All logs go to stderr; one startup line prints the listen URL and the `/docs` URL.
- Shutdown: first SIGINT/SIGTERM stops accepting connections and lets in-flight runs finish; a second signal cancels in-flight runs (child kill + container stop, as MCP cancellation does); exit 0.

## HTTP surface

| Method & path | Auth | Behaviour |
|---|---|---|
| `GET /` | none | `302` → `/docs`. |
| `GET /healthz` | none | `200 {status:"ok", version, tools, in_flight}`. Readiness/liveness probe target. |
| `GET /openapi.json` | none | OpenAPI 3.1 document, regenerated per request from the current generation (hot reload needs no cache invalidation). |
| `GET /docs` | none | Swagger UI HTML shell. |
| `GET /v1/workflows` | bearer | `{workflows: [{name, description, params}]}` from `deriveTools`. |
| `POST /v1/workflows/{name}/runs` | bearer | Start a run. Body: JSON object of params (all strings, required, `additionalProperties: false` — mirrors the MCP input schema). Default: `202` + run object (`status:"running"`) + `Location: /v1/runs/{id}`. `?wait=true`: respond only when terminal, `200` + final run object. |
| `GET /v1/runs` | bearer | Runs started by this server process (in-memory registry), newest first. |
| `GET /v1/runs/{id}` | bearer | Run object (below). `404` unknown. |
| `GET /v1/runs/{id}/events` | bearer | The run's `run_summary.jsonl`. `Accept: text/event-stream` → SSE: replay journal, then follow live until the run is terminal. Otherwise `application/x-ndjson` snapshot. |
| `GET /v1/runs/{id}/artifacts` | bearer | List of published artifacts (relative paths under the run's `artifacts/`). |
| `GET /v1/runs/{id}/artifacts/{path}` | bearer | Artifact download (`application/octet-stream`); path-traversal guarded. |
| `POST /v1/runs/{id}/cancel` | bearer | `202`; run reaches `status:"cancelled"`. `409` if already terminal. |

**Run object:** `{run_id, workflow, status: "running"|"succeeded"|"failed"|"cancelled", started_at, ended_at, exit_status, signal, result_text, run_dir}`. `result_text` is `composeResult`'s text (same content an MCP client sees), so results are mode-agnostic.

**Error shape:** `{error: {code, message}}` with proper status codes: `401 E_UNAUTHORIZED`, `404 E_NOT_FOUND`, `400 E_BAD_ARGS` (missing/non-string/unexpected param key), `405`, `409 E_RUN_TERMINAL`, `413 E_BODY_TOO_LARGE` (1 MiB JSON body cap), `415` (POST without `application/json`), `429 E_TOO_MANY_RUNS`. **A workflow failure is not an HTTP error** — the run object reports `status:"failed"` with `result_text` carrying the same failure narrative as MCP (`failed step`, excerpts, `run dir:`).

## Auth model

- Token from `JAIPH_SERVE_TOKEN` (env, never argv — argv leaks into process listings). Requests carry `Authorization: Bearer <token>`; comparison is constant-time (`timingSafeEqual`).
- **Fail closed on exposure:** binding a non-loopback `--host` without `JAIPH_SERVE_TOKEN` is a startup error. On loopback the token is optional.
- Unauthenticated endpoints (`/healthz`, `/openapi.json`, `/docs`) expose schema metadata only — workflow names, descriptions, and param names; never execution, run data, or artifacts. This is a deliberate trade so probes work and a browser can open `/docs` (browsers can't attach headers on navigation; Swagger UI's Authorize box supplies the bearer for the actual calls, with `persistAuthorization: true`). Documented plainly.
- No TLS in-process: deploy behind a reverse proxy / ingress. Documented, not compensated for.

## Execution model & run registry

- Reuse `callWorkflow` + `McpCallEnvironment` from `src/cli/mcp/call.ts`. Two small generalizations (MCP behavior unchanged):
  - the caller supplies `runId` (today `randomUUID()` is created inside `callWorkflow`, `call.ts:77`) so the server can register the run before the child exits;
  - `McpCallResult` gains `{runDir?, exitStatus?, signal?}` from `composeResult`'s inputs, so the server can populate the run object. Rename to `WorkflowCallResult` and move the module to `src/cli/exec/call.ts` shared by mcp + serve (hard-rewrite rename; `mcp` re-exports nothing).
- Generation state (module graph, `deriveTools`, scripts dir, hot reload via `watchFile`) is the same machinery as `commands/mcp.ts` (`loadState`, `rewatch`) — extract to `src/cli/shared/generation.ts` and use from both commands. Reload swaps the tool set and the OpenAPI content; in-flight runs keep their generation's scripts dir (per-generation dirs already make this safe — but the previous generation's dir must survive until its in-flight runs finish, so deletion is refcounted rather than immediate as in MCP today).
- Registry: in-memory `Map<runId, RunRecord>` (record = run object + cancel handle). Lost on restart; run dirs on disk remain the durable record. Documented.
- Concurrency cap: `JAIPH_SERVE_MAX_CONCURRENT` (default 4) on simultaneously-running workflows → `429` beyond it. Each HTTP-triggered run is a full sandboxed run (a container by default) — an uncapped public POST endpoint is a fork bomb.
- Sandbox posture: identical to `jaiph mcp` — env-driven Docker selection resolved once at startup, image prepared once, per-call snapshot isolation by default, `JAIPH_INPLACE=1` / `JAIPH_UNSAFE=true` opt-outs, credential preflight demoted to warnings, startup notice describing the mode.

## OpenAPI generation

- Hand-rolled document (a pure function `buildOpenApi(tools, serverInfo)` in `src/cli/serve/openapi.ts` — no generator dependency), OpenAPI **3.1.0**.
- One **concrete path per workflow** (`/v1/workflows/build_release/runs`), not a single parameterized path: each gets its own `description` (the workflow's `#` comments), `operationId`, and request-body schema (the exact MCP `inputSchema` object). This is what makes Swagger UI a usable per-workflow form.
- Plus the static run-resource paths, the run-object component schema, the error schema, and `components.securitySchemes.bearer` (`type: http, scheme: bearer`) applied to `/v1/*`.
- `info.title` = `jaiph — <file basename>`, `info.version` = jaiph `VERSION`.
- Validity is enforced by test: a dev-dependency OpenAPI 3.1 schema validator runs in unit tests only (runtime stays zero-dep).

## Swagger UI

`GET /docs` returns a small static HTML shell loading `swagger-ui-dist` from a CDN — **pinned exact version + SRI `integrity` hashes + `crossorigin="anonymous"`** — and initializing `SwaggerUIBundle({url: "/openapi.json", persistAuthorization: true})`.

Decision: CDN shell over embedding. Embedding swagger-ui (~1.5 MB js+css) via the existing `tools/embed-assets.js` mechanism would bloat every `jaiph` binary for one page; the shell is ~20 lines. Consequence, documented plainly: `/docs` needs internet access in the browser; air-gapped operators still have `/openapi.json`, which any locally-hosted Swagger/Redoc/Scalar renders. Revisit embedding only if air-gapped demand materializes.

## Events streaming

`GET /v1/runs/{id}/events` reads the run's `run_summary.jsonl` — the durable journal is the single source: it is complete (the live stderr stream lacks `WORKFLOW_*` events), already credential-redacted, hash-chained, and present on the host in every sandbox mode (the run dir is a host mount).

- NDJSON mode: stream the file's current content, close.
- SSE mode: replay all existing lines (`data: <raw json line>`), then poll the file (~250 ms) appending new lines as they land; when the registry marks the run terminal, emit `event: end` and close. Heartbeat comment lines (`:ka`) every 15 s keep proxies from idling the connection out.
- Clients never get un-redacted content: raw `%06d-*.out/.err` capture files are not exposed (only journal excerpts and published artifacts are).

## Testing

- Unit: request router/handlers as a class with injected `{getTools, callTool, registry, token, now}` (the `McpServer` pattern) — auth matrix, arg validation, error shapes, wait semantics, cancel, cap, OpenAPI content, SSE framing against a fake journal.
- Unit: `buildOpenApi` output passes a real OpenAPI 3.1 schema validator (devDep).
- Integration: real server on port 0 against a fixture `.jh` — full lifecycle (POST → 202 → poll → succeeded → events → artifacts), `wait=true` round-trip of a return value, workflow failure as `status:"failed"` with HTTP 200, hot reload surfacing a new workflow in `/openapi.json` without restart.
- e2e: curl-driven script in `e2e/tests/` (host mode + one Docker-sandboxed call).

## Documentation

- `docs/serve.md` — how-to: starting, auth, invoking with curl, Swagger UI, streaming events, deployment pointers.
- `docs/cli.md` — `jaiph serve` reference; `printUsage` in `src/cli/shared/usage.ts`; README feature bullet.
- `docs/env-vars.md` — rows for `JAIPH_SERVE_TOKEN`, `JAIPH_SERVE_MAX_CONCURRENT` (the src-parity lint pins this).
- Safety paragraph mirroring MCP's: an HTTP-exposed workflow is arbitrary shell reachable by anyone holding the token — that is the point; bind/token/proxy guidance follows.

## Out of scope (queued or future)

- A dedicated web UI beyond Swagger (a static viewer over `/v1/runs` + SSE is the natural next step once this API exists).
- TLS termination, CORS (denied by default — no `Access-Control-Allow-Origin` header until a UI needs it), rate limiting beyond the concurrency cap.
- Serving multiple `.jh` files from one server; webhooks/callbacks on run completion.
- OTLP/Sentry telemetry export (queued separately — it hooks run completion generically, not serve specifically).
