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
