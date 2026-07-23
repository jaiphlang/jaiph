# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Feat: `jaiph serve` — HTTP API with OpenAPI + Swagger UI #dev-ready

**Source:** Deployability feedback (2026-07-23): workflows must be invokable over the network and self-describing, not bound to a local stdio parent. Full contract: `design/2026-07-23-serve-http-api.md` — that document is the spec; this task pins the deliverable and its acceptance.

**Problem:** `jaiph mcp` (`src/cli/commands/mcp.ts`) exposes workflows only over stdio JSON-RPC to a co-located parent process. There is no way to invoke a workflow over HTTP, no machine-readable API description, and no browser-usable surface. This blocks running jaiph as a deployed service (docker/kubernetes) callable by other systems.

**Required behavior** (details, endpoint table, and error contract in the design doc):

* New command `jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>`, default `127.0.0.1:5247`, dispatched from `src/cli/index.ts`, implemented in `src/cli/commands/serve.ts` + `src/cli/serve/`. Hand-rolled on `node:http` — **no runtime npm dependencies** (project policy; the MCP server set the precedent). devDependencies for tests are fine.
* Startup identical in spirit to `jaiph mcp`: graph load + `collectDiagnostics` (errors → stderr, exit 1), `--env` resolved once via `resolveEnvPairs`, Docker config resolved once, image prepared once, credential preflight as warnings, sandbox-mode startup notice. Logs to stderr; startup line prints listen URL + `/docs` URL.
* Endpoints (this task): `GET /` → 302 `/docs`; `GET /healthz`; `GET /openapi.json`; `GET /docs`; `GET /v1/workflows`; `POST /v1/workflows/{name}/runs` (async `202` + `Location`, or `?wait=true` → `200` terminal); `GET /v1/runs`; `GET /v1/runs/{id}`; `POST /v1/runs/{id}/cancel`. Run object and `{error:{code,message}}` shape per the design doc. A workflow failure is **not** an HTTP error (run object `status:"failed"`, HTTP 200/202).
* Exposure, naming, descriptions, and request-body schemas come from `deriveTools` (`src/cli/mcp/tools.ts`) — identical rules to MCP (export-narrowing, route-target exclusion, `default` handling, required-string params, `additionalProperties: false`). Param validation mirrors the MCP `-32602` rules as HTTP 400.
* Execution reuses the MCP call layer: move `src/cli/mcp/call.ts` to `src/cli/exec/call.ts`, rename `McpCallResult` → `WorkflowCallResult`, let the caller supply `runId` (today created inside `callWorkflow`), and extend the result with `{runDir?, exitStatus?, signal?}`. `jaiph mcp` behavior is unchanged after the move (its tests prove it). Sandbox selection, `--env` passthrough, and cancellation (child kill + `stopDockerContainer`) work exactly as for MCP calls.
* Hot reload: extract the generation machinery (`loadState`, watch/rewatch, generation dirs) from `src/cli/commands/mcp.ts` into `src/cli/shared/generation.ts`, used by both commands. For serve, a superseded generation's out dir is deleted only after its in-flight runs finish (refcount), since HTTP runs can outlive a reload.
* Auth: bearer token from `JAIPH_SERVE_TOKEN`, constant-time compare; required for all `/v1/*`; `/healthz`, `/openapi.json`, `/docs` stay unauthenticated (schema metadata only — documented trade). **Binding a non-loopback host without the token set is a startup error.**
* Concurrency cap `JAIPH_SERVE_MAX_CONCURRENT` (default 4) on simultaneous runs → `429`. Body cap 1 MiB → `413`; non-JSON POST → `415`.
* `GET /openapi.json`: OpenAPI **3.1.0** generated per request by a pure `buildOpenApi(tools, serverInfo)` (`src/cli/serve/openapi.ts`): one concrete path per workflow (own `operationId`, description from `#` comments, MCP input schema as request body), the run-resource paths, run/error component schemas, bearer `securityScheme`.
* `GET /docs`: static Swagger UI shell loading `swagger-ui-dist` from CDN with **pinned exact version + SRI integrity hashes + crossorigin**, `SwaggerUIBundle({url:"/openapi.json", persistAuthorization:true})`. No embedded/vendored UI assets (decision + air-gap consequence recorded in the design doc; `/openapi.json` is the offline fallback).
* Shutdown: first SIGINT/SIGTERM stops accepting and drains in-flight runs; second signal cancels them; exit 0.
* Docs: new `docs/serve.md` how-to; `docs/cli.md` section; `printUsage` in `src/cli/shared/usage.ts`; README bullet; `docs/env-vars.md` rows for `JAIPH_SERVE_TOKEN` and `JAIPH_SERVE_MAX_CONCURRENT` (src-parity docs-lint pins every new `JAIPH_*` name).

Acceptance:

* Integration test (real server, port 0, fixture `.jh`): `POST /v1/workflows/{name}/runs?wait=true` round-trips a workflow `return` value in `result_text` with `status:"succeeded"`; async POST returns `202` + `Location`, and polling `GET /v1/runs/{id}` reaches the same terminal result; the run dir exists under `.jaiph/runs/` with `run_summary.jsonl`.
* Integration test: a failing workflow returns HTTP 200 (`wait=true`) with `status:"failed"`, `exit_status` set, and `result_text` containing the failed step and `run dir:` — proving workflow failure is not an HTTP error.
* Unit tests (injected-deps handler, `McpServer`-style): unknown workflow → 404; missing / non-string / unexpected param key → 400; cancel → 202 then terminal `cancelled` (child + container teardown invoked), cancel on terminal run → 409; concurrency cap → 429; body cap → 413; non-JSON POST → 415.
* Auth matrix test: with `JAIPH_SERVE_TOKEN` set, `/v1/*` without or with a wrong bearer → 401 and correct bearer → 200, while `/healthz`, `/openapi.json`, `/docs` answer 200 unauthenticated; a unit test proves non-loopback `--host` without the token exits 1 before listening.
* `buildOpenApi` output passes a real OpenAPI 3.1 schema validator (devDependency, test-only); a test asserts one path per exposed workflow with the exact MCP-derived schema, covering the export-narrowing fixture.
* A test asserts the `/docs` HTML pins an exact `swagger-ui-dist` version with `integrity` + `crossorigin` attributes on both assets.
* Hot-reload integration test: adding a workflow to the fixture file surfaces it in `/openapi.json` and `/v1/workflows` without restart; a run started before the reload still completes successfully.
* `jaiph mcp` unit/integration tests pass unchanged after the `call.ts`/generation extraction (no behavior drift in the shared layer).
* `package.json` `dependencies` remains absent/empty; `npm test` passes (which enforces the env-vars docs parity rows).

***

## Feat: `jaiph serve` run inspection — live event stream + artifacts #dev-ready

**Source:** Deployability feedback (2026-07-23): "a UI on top to be able to inspect what it is doing" — the API half of that is streaming run events and exposing artifacts over HTTP. Contract: `design/2026-07-23-serve-http-api.md` (§ Events streaming). Requires the `jaiph serve` command (`src/cli/commands/serve.ts`, run registry + bearer auth) already in the codebase.

**Problem:** A `jaiph serve` client can see a run's terminal result but not what the run is doing while it executes, and cannot retrieve published artifacts. The durable journal (`run_summary.jsonl`, written by `RuntimeEventEmitter` — hash-chained, credential-redacted, host-visible in every sandbox mode because the run dir is a host mount) already contains everything needed; it just isn't reachable over HTTP.

**Required behavior:**

* `GET /v1/runs/{id}/events` (bearer-authed, 404 unknown run):
  * default: `application/x-ndjson` — the run's `run_summary.jsonl` content as-is, then close.
  * `Accept: text/event-stream` → SSE: replay every existing journal line as `data: <raw json line>`, then follow the file (poll ~250 ms) emitting new lines as they append; when the server's registry marks the run terminal, emit `event: end` and close. Keep-alive comment (`:ka`) every 15 s. Works for already-terminal runs (full replay + immediate `end`).
  * The journal is served verbatim — the redaction already applied by `RuntimeEventEmitter` is the redaction guarantee. Raw `%06d-*.out/.err` capture files are **never** exposed by any endpoint.
* `GET /v1/runs/{id}/artifacts` → JSON list of files under the run dir's `artifacts/` (relative paths, size, mtime); empty list when none.
* `GET /v1/runs/{id}/artifacts/{path}` → file bytes, `application/octet-stream`, `Content-Disposition` filename. **Traversal-proof:** resolve the requested path against the artifacts dir and reject (404) anything escaping it — `..` segments, absolute paths, and symlinks pointing outside the artifacts dir (check `realpath` containment, not string prefix only).
* Docker-mode runs: the journal/artifacts are read from the host-side run dir (discovered as the existing call layer already does via `discoverDockerRunDir`/`remapContainerPath` in `src/cli/shared/errors.ts`).
* Docs: extend `docs/serve.md` with a "watch a run" section (curl SSE example) and artifacts section; note the raw-captures non-exposure as a security property.

Acceptance:

* Integration test with a multi-step fixture workflow slow enough to observe (e.g. `sleep` steps): connect SSE mid-run and assert (a) replayed `WORKFLOW_START` arrives, (b) at least one `STEP_END` event arrives **before** the run is terminal, (c) `event: end` arrives and the socket closes after completion, (d) the concatenated `data:` payloads equal the final `run_summary.jsonl` line set.
* Test: NDJSON mode on a terminal run byte-matches the journal file; events endpoint on an unknown run id → 404; unauthenticated → 401.
* Redaction test: a workflow that echoes a credential env value (key matching the `_API_KEY`/`_TOKEN` redaction suffixes, value ≥8 chars) produces an event stream where the value is absent and `[REDACTED]` present.
* Artifacts round-trip test: a workflow publishing a file to `$JAIPH_ARTIFACTS_DIR` lists and downloads it byte-identically.
* Traversal test battery: `../`-containing path, absolute path, URL-encoded `%2e%2e`, and a symlink inside `artifacts/` pointing outside the run dir all return 404 without reading the target; a symlink target **inside** artifacts still serves.
* A grep-style test or unit assertion proves no route serves `*.out`/`*.err` capture files.
* `npm test` passes.

***

## Feat: OTLP trace export — one span tree per run, zero dependencies #dev-ready

**Source:** Observability feedback (2026-07-23): "OTEL + Sentry configurable would be the easiest way" to make jaiph observable in a company setting. This task is the OTEL half.

**Problem:** A jaiph run already produces a complete, credential-redacted, hash-chained event timeline (`run_summary.jsonl`, written by `RuntimeEventEmitter`, `src/runtime/kernel/runtime-event-emitter.ts`), but it is invisible to standard observability stacks (Grafana/Tempo, Honeycomb, Datadog, any OTLP collector). Operators running workflows in CI or as a service have no traces, no latency breakdown per step/prompt, and no failure signal outside the local run dir.

**Required behavior:**

* **Architecture decision (pinned):** export happens **host-side, after the run completes, by reading the run's `run_summary.jsonl`** — not inside the runtime/emitter. Rationale: the journal is complete (the live stderr stream lacks `WORKFLOW_*` events), already redacted, and host-visible in every sandbox mode (the run dir is a host mount), so nothing new crosses the container boundary and no `OTEL_*` env forwarding into the sandbox is needed. Runs are minutes-long; end-of-run batching is the normal OTLP pattern anyway.
* New module `src/cli/telemetry/otlp.ts`, zero runtime dependencies (`node:https`/`node:http` request only):
  * a **pure** function `runSummaryToOtlp(lines, meta)` mapping journal lines + `{workflow, exitStatus, signal, serviceName, resourceAttributes}` to an OTLP/HTTP **JSON** `ExportTraceServiceRequest`;
  * a poster with a 10 s timeout.
* Mapping contract:
  * `traceId` = the run id UUID with dashes stripped (32 hex chars — OTLP/JSON encodes trace/span ids as hex per the spec's JSON mapping); `spanId` = first 16 hex chars of `sha256(<event id>)`. Deterministic: re-exporting a run yields identical ids.
  * Root span per run: name `workflow <name>`, from `WORKFLOW_START`/`WORKFLOW_END` timestamps (fallback: first/last event `ts`); status `ERROR` (code 2) when `exitStatus !== 0` or a signal terminated the run, else `OK`.
  * One span per `STEP_START`/`STEP_END` pair (matched by event `id`), parented via the event's `parent_id` (root when null); `kind: SPAN_KIND_INTERNAL`; attributes: `jaiph.step.kind`, `jaiph.step.func`, `jaiph.step.name`, `jaiph.step.seq`, `jaiph.step.depth`, `jaiph.step.status`, `jaiph.step.elapsed_ms`; span status ERROR when the step status is nonzero.
  * `PROMPT_START`/`PROMPT_END` pairs become child spans of their `step_id` with `jaiph.prompt.backend`, `jaiph.prompt.model`, `jaiph.prompt.status`.
  * `LOGERR`/`LOGWARN` become span events on the root span. `ts` (ISO) → `timeUnixNano` as strings. A `STEP_START` with no matching `STEP_END` (crash) closes at the last event timestamp with status ERROR.
  * Resource: `service.name` from `OTEL_SERVICE_NAME` (default `jaiph`), pairs from `OTEL_RESOURCE_ATTRIBUTES`, plus `jaiph.version`, `jaiph.run_id`, `jaiph.workflow`, `jaiph.source`.
* Enablement & endpoint (standard OTEL env, no new `JAIPH_*` unless genuinely needed — any that is added must get its `docs/env-vars.md` row, the parity lint enforces this): enabled iff `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used verbatim) or `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, `/v1/traces` appended) is set. `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `k=v`) applied. Only `http/json` is spoken: if `OTEL_EXPORTER_OTLP_PROTOCOL` is set to anything other than `http/json`, warn on stderr and skip export (respect the operator's explicit intent rather than mis-speak a protocol).
* Hook point: a single shared post-run function (e.g. `exportRunTelemetry({runDir, workflow, exitStatus, signal, env})`) invoked wherever a run reaches terminal state on the host — `jaiph run` completion and the shared workflow-call layer used by MCP tool calls (`src/cli/mcp/call.ts` or its current location). One choke point, all modes covered (host, Docker snapshot, inplace).
* **Failure semantics: telemetry is never load-bearing.** Unreachable/erroring collector → exactly one stderr warning line; the run's exit code, output, and journal are untouched. No retries, no queue.
* Docs: `docs/observability.md` how-to (enabling against a local `otel-collector`, one hosted-backend example, span-tree screenshot-level description of what maps to what); `docs/env-vars.md` gets a "Telemetry variables" section listing the consumed `OTEL_*` names (the page already covers non-`JAIPH_*` vendor variables); README bullet.

Acceptance:

* Unit tests on `runSummaryToOtlp` with fixture journals: trace id derived from run id; step span parented per `parent_id`; prompt span is a child of its `step_id` with backend/model attributes; failed step → span status 2; nonzero run exit → root status 2; ISO `ts` → correct `timeUnixNano` strings; unmatched `STEP_START` closes with ERROR at last event time; deterministic ids across two invocations.
* Unit tests: endpoint resolution (traces-specific verbatim vs generic + `/v1/traces`; traces-specific wins when both set), header parsing, `http/json`-only protocol guard (warn + skip on `grpc`).
* Integration test: a local fake-collector HTTP server receives exactly one well-formed POST to `/v1/traces` after a `jaiph run` with the env set; the same run with no OTEL env sends nothing; with the collector returning 500 (and separately: connection refused), the run's exit code is 0 and exactly one warning line appears on stderr.
* Integration test: an MCP `tools/call` (or shared-call-layer invocation) also triggers exactly one export per call.
* Redaction test: a credential value present in step output appears in the exported payload only as `[REDACTED]` (the export reads the journal, never raw captures).
* `package.json` `dependencies` remains absent/empty; `npm test` passes.

***

## Feat: Sentry error reporting on failed runs #dev-ready

**Source:** Observability feedback (2026-07-23): "OTEL + Sentry configurable". This task is the Sentry half: failed workflow runs become Sentry error events so operators get alerting/grouping without scraping run dirs.

**Problem:** A failed run's only trace is its local run dir and a nonzero exit code. Teams running jaiph workflows on schedules or as a service (CI, k8s) need failures pushed to their error tracker with enough context to triage — workflow, failing step, redacted output excerpt, run dir pointer.

**Required behavior:**

* New module `src/cli/telemetry/sentry.ts`, zero runtime dependencies — a Sentry **envelope** POST hand-rolled over `node:https` (create `src/cli/telemetry/http.ts` for the shared timeout-guarded POST helper if `src/cli/telemetry/` already has one, reuse it).
* Enabled iff `SENTRY_DSN` is set. DSN `https://<key>@<host>/<projectId>` parses to endpoint `https://<host>/api/<projectId>/envelope/` with header `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<key>, sentry_client=jaiph/<VERSION>`. Malformed DSN → one stderr warning, no send.
* Fires **only** when a run terminates unsuccessfully (nonzero exit or signal), from the same host-side post-run hook that handles run completion for all modes (`jaiph run` and the shared MCP/HTTP call layer) — one choke point. Successful runs send nothing.
* Event content (all excerpts sourced from the run's `run_summary.jsonl`, which is already credential-redacted — never from raw `.out`/`.err` captures):
  * `event_id` = run id UUID, dashes stripped; `timestamp`; `platform: "node"`; `level: "error"`;
  * `message.formatted` = `workflow <name> failed (exit N)` / `terminated by signal S`;
  * `tags`: `jaiph.workflow`, `jaiph.source` (basename), failing step kind/name when known;
  * `extra`: failing step detail excerpt (the `STEP_END` `err_content`/`out_content`), `run_dir`;
  * `fingerprint`: `["jaiph", <workflow>, <failing step name or "unknown">]` so re-occurrences group per workflow+step;
  * `release` = `SENTRY_RELEASE` or `jaiph@<VERSION>`; `environment` = `SENTRY_ENVIRONMENT` when set.
  * Envelope body = header line `{"event_id","sent_at"}` + item header `{"type":"event"}` + event JSON, newline-separated.
* **Failure semantics: never load-bearing.** Unreachable Sentry, non-2xx, timeout (10 s) → exactly one stderr warning; run exit code and output untouched. No retries.
* No new `JAIPH_*` variables expected; if any is introduced it gets its `docs/env-vars.md` row (parity lint). `SENTRY_DSN`/`SENTRY_ENVIRONMENT`/`SENTRY_RELEASE` are documented in the env-vars page's non-`JAIPH_*` telemetry section and in `docs/observability.md`.

Acceptance:

* Unit tests: DSN parsing (endpoint + auth header; malformed → warn/no-send), envelope framing (three newline-separated JSON documents, `event_id` matches run id hex), fingerprint and message composition for exit-code vs signal terminations.
* Integration test with a local fake-Sentry HTTP server: a failing `jaiph run` with `SENTRY_DSN` set delivers exactly one envelope whose event carries the failing step tag and redacted excerpt; a succeeding run delivers nothing; a failing run **without** `SENTRY_DSN` delivers nothing.
* Failure-isolation test: fake Sentry returns 500 (and separately: connection refused) — the run's exit code is unchanged from the no-DSN baseline and exactly one warning line lands on stderr.
* Redaction test: a credential value that appears in the failing step's output shows up in the delivered event only as `[REDACTED]`.
* `package.json` `dependencies` remains absent/empty; `npm test` passes.

***

## Feat: standalone runtime image — run jaiph in docker/k8s without a host orchestrator #dev-ready

**Source:** Deployability feedback (2026-07-23): "a docker image with codex/cursor/claude code already installed so that the user only needs to put the credentials + the jaiph files and run it … that would allow anyone to run jaiph in docker/kubernetes" — and "it can't depend on a local machine + docker".

**Problem:** `ghcr.io/jaiphlang/jaiph-runtime` (`runtime/Dockerfile`) already contains jaiph plus the claude/cursor/codex backends and a full toolchain, but it is only ever used as a sandbox rootfs *orchestrated by a host jaiph process*. Running it directly (`docker run … jaiph run flow.jh`, or as a k8s pod) fails the wrong way: jaiph defaults to Docker sandboxing on Linux and there is no Docker daemon inside the container. There is also zero documentation for deploying the image as the runner itself, even though `.github/workflows/nightly-engineer.yml` proves jaiph works headless on a bare Linux box.

**Required behavior:**

* **Bake `ENV JAIPH_UNSAFE=true` into `runtime/Dockerfile`** with a comment stating the rationale: *inside this image, the container is the sandbox* — host-mode execution is the correct default, and the interactive `--unsafe` confirmation is impossible/meaningless in an unattended pod. Verify and pin by test that this does not change host-orchestrated sandbox behavior: the container-inner invocation is `jaiph run --raw`, which by contract never launches Docker regardless of `JAIPH_UNSAFE` (the existing Docker e2e suite must stay green with the ENV present).
* Do **not** add an `ENTRYPOINT` and do not change `WORKDIR`: the host-orchestrated sandbox passes an explicit command argv, and an entrypoint prefix would corrupt it. Standalone usage spells the full command (`docker run … ghcr.io/jaiphlang/jaiph-runtime jaiph run /work/flow.jh`).
* When jaiph would launch Docker but the CLI is unavailable **and** a container indicator is present (`/.dockerenv` or `/run/.containerenv`), the error message must say precisely what to do: running inside a container already — set `JAIPH_UNSAFE=true` (host mode; the container is the sandbox). This covers users of derived images without the baked ENV.
* New `docs/deploy.md` (how-to, linked from README, `docs/sandboxing.md`, and `docs/setup.md`):
  * one-shot: `docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work ghcr.io/jaiphlang/jaiph-runtime jaiph run flow.jh` (and the cursor/codex credential variants — `CURSOR_API_KEY`, `OPENAI_API_KEY`);
  * CI usage note pointing at the pattern `nightly-engineer.yml` already uses;
  * Kubernetes: a real manifest file `docs/deploy/k8s.yaml` (Deployment + Secret for backend credentials + Service; liveness/readiness probes; image tag pinning note; TLS-via-ingress note; resource-request guidance — agent workloads are CPU/memory hungry). If `jaiph serve` exists in the codebase when this task is implemented, the manifest runs `jaiph serve --host 0.0.0.0` with `JAIPH_SERVE_TOKEN` from the Secret and probes `/healthz`; otherwise the manifest demonstrates a long-lived workflow runner and the doc says the HTTP surface is queued.
  * A plainly-stated security paragraph: in standalone mode there is **no** jaiph-managed sandbox — isolation is whatever the deployment provides (the container/pod boundary), and workspace content policy (gitignored secrets etc.) is the operator's responsibility, unlike the host-orchestrated snapshot sandbox.
* CI smoke test (job in `.github/workflows/ci.yml` on the built image, or a gated e2e in `e2e/tests/` where the image is available): run the image standalone with `docker run` executing a fixture workflow that writes a `return` value; assert the value round-trips and exit code 0 — proving the "put credentials + jaiph files and run it" story on every build.
* Manifest validity gate: `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` (kubectl is on GitHub runners) runs in CI and passes.
* No new `JAIPH_*` env vars expected; any introduced must get `docs/env-vars.md` rows (parity lint). Update the `JAIPH_UNSAFE` row to mention the image bakes it.

Acceptance:

* CI (or gated e2e) smoke test: `docker run --rm -v <fixture>:/work -w /work <image> jaiph run hello.jh` exits 0 and produces the expected return value, with no Docker daemon available inside the container.
* The full existing Docker-sandbox e2e suite passes against the image with the baked `ENV JAIPH_UNSAFE=true` (host-orchestrated behavior unchanged).
* Unit test for the container-detection error path: docker unavailable + `/.dockerenv` present (injectable check) yields the "container is the sandbox → set JAIPH_UNSAFE=true" message; without the indicator, the existing error is unchanged.
* `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` passes in CI.
* `docs/deploy.md` exists, is linked from README + `docs/sandboxing.md` + `docs/setup.md`, and documents the no-jaiph-sandbox security posture explicitly.
* `npm test` and `npm run test:e2e` pass.

***
