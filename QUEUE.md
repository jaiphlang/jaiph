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

## Keep MCP generations alive while calls are in flight #dev-ready

`jaiph mcp` handles tool calls concurrently, but hot reload immediately deletes the previous generation's scripts directory. A call started just before reload can still need those scripts. Signal shutdown also removes the shared temp root without draining or cancelling active calls. `jaiph serve` already refcounts generations; MCP needs the same lifecycle guarantee.

Scope:

- Share or mirror the generation lease/refcount model for MCP and HTTP.
- Delete a superseded generation only after its last call settles.
- On stdin close, drain active calls before cleanup. On SIGINT/SIGTERM, use a documented drain-then-cancel policy and stop Docker containers as well as child processes.

Acceptance:

- A slow MCP call started before a source reload completes successfully after the new generation is active.
- Concurrent calls spanning multiple reloads use the generation captured at call start and leave no generation directories after all calls settle.
- Shutdown tests prove no active call reads deleted scripts and no child process/container is orphaned.

## Make the Kubernetes example runnable and hardened by default #dev-ready

The current manifest mounts the workflow ConfigMap read-only at `/work`, while standalone host mode writes runs under `/work/.jaiph/runs`; the example is schema-valid but cannot complete a real run. It also ships publicly known placeholder secrets and omits the pod hardening that `docs/deploy.md` says the operator must supply.

Scope:

- Mount a writable `emptyDir` or PVC for `JAIPH_RUNS_DIR` without making workflow sources writable.
- Remove applyable placeholder credentials from the base manifest; document and validate an external Secret contract.
- Add `runAsNonRoot`, fixed UID/GID, `allowPrivilegeEscalation: false`, dropped capabilities, a runtime-default seccomp profile, and disabled service-account token mounting.
- Provide writable mounts only for paths genuinely required by Jaiph and agent CLIs; keep the remaining filesystem read-only where feasible.
- Add optional OTLP and Sentry env wiring examples without embedding credentials.

Acceptance:

- A Kind-based test applies the manifest, invokes the HTTP workflow with auth, observes a successful run, and reads its journal from the writable runs volume.
- The pod runs as non-root and the test fails if privilege escalation, capabilities, or the default service-account token are reintroduced.
- `kubectl apply --dry-run=client` remains a fast schema check, but is not the only deployment test.

## Bound HTTP service memory, output, and run retention #dev-ready

The concurrency cap limits active children but not process memory. The in-memory run map grows forever, completed `result_text` stays resident forever, and raw child stdout/stderr/log accumulation is not bounded. An authenticated caller can exhaust a long-lived service.

Scope:

- Add explicit byte caps for collected stdout, stderr, logs, and public `result_text`, with a visible truncation marker.
- Add configurable completed-run retention by count and age; active runs must never be evicted.
- Paginate `GET /v1/runs` with a bounded default and maximum page size.
- Keep durable journals/artifacts independent from in-memory eviction and document their disk-retention responsibility.

Acceptance:

- Runs producing output beyond every cap keep the process within a tested memory bound and return deterministic truncation markers.
- More completed runs than the configured limit evicts only the oldest terminal records.
- Run listing cannot return an unbounded response, and pagination order is stable.
- Concurrency, cancellation, SSE, and artifact tests continue to pass.

## Make HTTP request, event, and artifact I/O scale with bytes transferred #dev-ready

The HTTP layer still performs avoidable whole-resource work: an aborted request body can leave `readBody` pending, SSE repeatedly scans historical run directories until `run_dir` is known, each SSE poll rereads the whole journal, and artifact downloads load the complete file into memory.

Scope:

- Settle request-body reads on `aborted`/premature `close` and stop all associated work.
- Cache `run_id -> run_dir` as soon as it is first resolved so a live SSE stream does not repeatedly scan the runs tree.
- Follow journals with an open file descriptor and byte offset instead of rereading prior bytes on every poll.
- Stream artifacts with backpressure and an explicit configurable size policy; do not buffer the complete artifact.

Acceptance:

- Destroying a request mid-upload settles its handler promptly and leaves no request or run slot occupied.
- With many historical runs, one live SSE connection performs at most one full run-directory resolution scan.
- Instrumented SSE tests prove bytes before the current offset are not reread.
- A multi-gigabyte sparse artifact can be served with bounded process memory, and disconnecting the client closes the file stream.

## Use one execution-policy contract across run, serve, and MCP #dev-ready

The shared parser accepts flags for every command, but commands silently ignore options they do not destructure. For example, `jaiph serve --unsafe` and `jaiph mcp --inplace` parse successfully but do not apply those flags. `run` exposes sandbox flags while long-lived modes require env vars, creating different mental models for the same execution engine.

Scope:

- Define shared options for `--workspace`, repeatable `--env`, `--inplace`, `--unsafe`, and `--yes`; support them consistently in `run`, `serve`, and `mcp`.
- Define and document one precedence order across CLI flags, `JAIPH_*` env vars, and workflow runtime metadata.
- Reject mutually exclusive posture and all command-specific unsupported flags as usage errors instead of treating or ignoring them as positionals.
- Resolve and print the effective sandbox posture once at server startup, then apply it to every call. Preserve the documented standalone-container exception where the container/pod is the sandbox.
- Decide and implement one lifecycle-hook contract for all three modes; mode differences must be explicit rather than caused by separate execution paths.
- Keep display-only options such as `--raw` and transport options such as `--host`/`--port` command-specific.

Acceptance:

- A table-driven integration suite runs the same sandbox/env cases through all three modes and observes the same effective child env and filesystem isolation.
- `serve --unsafe`, `serve --inplace`, `mcp --unsafe`, and `mcp --inplace` have tested effects; conflicting flags fail before spawning.
- Flags belonging to another command fail with a clear usage error.
- Hook tests prove the documented contract for direct, HTTP, and MCP invocations.
- Command help and env-var reference describe the same precedence and consent rules.

## Give every run mode complete, bounded telemetry behavior #dev-ready

Normal `jaiph run`, HTTP calls, and MCP calls invoke the shared OTLP/Sentry hook, but `jaiph run --raw` bypasses it while the docs claim every run is covered. OTLP and Sentry are awaited sequentially, so unavailable backends can hold a completed run and a service concurrency slot for up to 20 seconds despite being described as non-load-bearing.

Scope:

- Export telemetry for a user-invoked standalone `jaiph run --raw` without double-exporting the inner raw process used by host-orchestrated Docker.
- Run independent exporters concurrently under one configurable total flush budget.
- In long-lived HTTP/MCP processes, mark the run terminal and release execution concurrency before best-effort delivery; track delivery failures through bounded logging/metrics.
- Keep telemetry operator-side: `OTEL_*` and `SENTRY_*` values must not enter workflow sandboxes unless explicitly passed as workflow env.

Acceptance:

- Standard run, standalone raw run, MCP, and HTTP each produce one OTLP trace; each failed mode produces one Sentry event.
- A Docker-sandboxed run still exports exactly once.
- Unreachable telemetry endpoints cannot delay an HTTP/MCP terminal result or occupied execution slot beyond a small tested bound.
- Export failures never change workflow output or exit status.

## Expose HTTP API and network MCP from one service process #dev-ready

Today `jaiph serve` is HTTP-only and `jaiph mcp` is stdio-only. The same file can be exposed by two separate processes, but there is no single deployed company service that serves both protocols or a Kubernetes-addressable MCP endpoint.

Scope:

- Add standards-compliant MCP Streamable HTTP to `jaiph serve` on a documented path while retaining the existing REST/OpenAPI API.
- Reuse the same tool generation, hot reload, auth boundary, concurrency limiter, cancellation, sandbox/env policy, run IDs, artifacts, and telemetry for both transports.
- Keep `jaiph mcp` stdio for local clients; do not duplicate workflow execution logic.
- Document reverse-proxy requirements for streaming, timeouts, TLS, and authentication.

Acceptance:

- One process serves REST and MCP clients concurrently against the same workflow generation.
- MCP calls appear in the same run inspection API and obey the same concurrency and cancellation rules.
- Bearer auth protects both protocol surfaces on non-loopback binds.
- Docker and Kind integration tests exercise both transports from outside the container/pod.

## Make service runs restart-safe and retry-safe #dev-ready

Run artifacts are durable, but HTTP run discovery is only an in-memory map. Restarting the process makes completed run IDs unreachable, loses in-flight state, and makes client retries start duplicate expensive workflows. This is a single-process developer server, not yet a reliable company service contract.

Scope:

- Persist the public run record beside the journal and reconstruct terminal runs on startup.
- Reconcile interrupted `running` records after process death into an explicit terminal state.
- Support an idempotency key on run creation, scoped to workflow plus authenticated principal, with conflict detection for a reused key and different arguments.
- Define the supported deployment topology explicitly. If multi-replica operation is not implemented, fail/document it as single-replica and keep the Kubernetes example at one replica.

Acceptance:

- After restart, list/get/events/artifacts work for pre-restart terminal runs.
- A run interrupted by process death is not reported as permanently running.
- Repeating an identical create request with the same idempotency key returns the original run; changed arguments produce a conflict and never spawn.
- Recovery and idempotency survive a real process restart integration test.

## Add production authentication, authorization, and audit identity #dev-ready

`JAIPH_SERVE_TOKEN` is a useful fail-closed shared-secret gate, but it provides no user identity, revocation, per-action authorization, or attribution. That is insufficient when multiple company users can invoke arbitrary engineering workflows.

Scope:

- Keep the static bearer token as an explicit single-operator mode.
- Add a standard OIDC/JWT mode configured by issuer, audience, and JWKS discovery; use a maintained JWT library rather than custom cryptography.
- Authorize separate invoke, inspect/artifact, and cancel capabilities.
- Attach authenticated principal and request/correlation ID to run metadata, logs, OTLP resources, and Sentry tags without putting tokens or claims containing secrets into journals.
- Make exposure of `/docs` and `/openapi.json` configurable; keep health probes free of credentials and sensitive details.

Acceptance:

- Valid, expired, wrong-audience, wrong-issuer, unknown-key, and insufficient-scope tokens are covered by integration tests.
- A principal cannot inspect or cancel runs outside its authorization policy.
- Audit records identify who invoked and cancelled a run while never containing bearer tokens.
- Static-token mode remains tested and clearly documented as single-operator, not multi-tenant authentication.
