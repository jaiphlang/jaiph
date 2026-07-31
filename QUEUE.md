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

## Self-host Swagger UI for `jaiph serve` (no CDN) #dev-ready

Context: Feature — `/docs` already serves a Swagger UI shell, but it loads `swagger-ui-dist` from a pinned CDN with SRI (`src/cli/serve/docs.ts`). Air-gapped and hardened deployments get a blank page; only `/openapi.json` remains usable offline. The serve design doc deferred embedding (~1.5 MB) until air-gapped demand; that demand is now explicit.

Problem: `GET /docs` requires the browser to fetch JS/CSS from `cdn.jsdelivr.net`. With no egress, or with a CSP that blocks that host, operators cannot invoke or inspect workflows from the built-in UI even though the HTTP API is healthy.

Location: `src/cli/serve/docs.ts`; `tools/embed-assets.js` (existing embed pipeline); `docs/serve.md` § Swagger UI; `src/cli/serve/docs.test.ts`.

Remediation: Embed the pinned `swagger-ui-dist` assets (or an equivalent minimal OpenAPI renderer) into the jaiph binary via the existing embed-assets mechanism, serve them from same-origin paths under `/docs`, and keep SRI or integrity checks appropriate for first-party assets. Preserve `JAIPH_SERVE_EXPOSE_DOCS` and the Authorize / `persistAuthorization` behaviour. Document that `/docs` no longer needs browser internet access.

### Acceptance criteria
- With network egress blocked in the browser (or CDN unreachable), `GET /docs` still renders a working Swagger UI that loads `/openapi.json` and can invoke a workflow (Authorize + try-it-out) when a token is configured.
- No `cdn.jsdelivr.net` (or other third-party host) references remain in the `/docs` HTML or its loaded assets; a test asserts same-origin asset URLs only.
- `JAIPH_SERVE_EXPOSE_DOCS=false` still returns `404` for `/docs` and `/openapi.json`.
- Docs (`docs/serve.md`, CLI help) state that `/docs` is self-contained and does not require browser internet access.

## Redact credentials in durable `log` / `logwarn` / `logerr` journal lines #dev-ready

Context: ASI-06, LOW, confidence 0.75. Finding L-1 — `log()` messages persisted to the journal are not credential-redacted.

Problem: `emitLog` appends the durable LOG/LOGWARN/LOGERR payload without `redactCredentials`, unlike `emitStep`/`emitPromptEvent` (`runtime-event-emitter.ts:213-228`). A workflow that does `log("…${SOME_TOKEN}…")` persists the raw value into `run_summary.jsonl` (and streams it unredacted on the live `__JAIPH_EVENT__` stderr that hooks consume), whereas the same value inside a step's captured output would be `[REDACTED]` — an inconsistent redaction boundary, not a documented exception.

Location: `src/runtime/kernel/runtime-event-emitter.ts:213-228`.

Remediation: run `redactCredentials(message, this.env)` on `LOG`/`LOGWARN`/`LOGERR` durable payloads so all persisted fields share one boundary.

### Acceptance criteria
- A workflow that `log`s a value matching a credential env var persists `[REDACTED]` (not the raw secret) in `run_summary.jsonl`; a test asserts the journal line is redacted.
- The same redaction applies to `logwarn` and `logerr` durable payloads; a test covers at least one of those paths.
- Step/prompt redaction behaviour is unchanged; a regression test still asserts step capture redaction.

## Add a host-mode wall-clock timeout and optional max-step circuit breaker #dev-ready

Context: ASI-10, LOW, confidence 0.85. Finding L-2 — no host-mode wall-clock timeout, step cap, or circuit breaker (kill-switch control absent).

Problem: Docker timeout exists only for Docker mode (`docker.ts:157-176`); the host spawn in `run.ts` / `lifecycle.ts` has only user-signal SIGINT/SIGTERM handlers, no timer; the per-prompt idle watchdog covers individual backend calls only. The only automatic stop for a host/`--unsafe` run is a manual Ctrl-C. There is no overall wall-clock cap, no max-step / max-iteration bound, and no circuit breaker — the ASI-10 controls the checklist looks for. (Framed strictly as a missing kill-switch control, not a DoS finding.)

Location: `src/runtime/docker.ts:157-176`; `src/cli/commands/run.ts`; `src/cli/run/lifecycle.ts`; `src/cli/exec/call.ts`.

Remediation: add a parent-enforced overall run timeout (for host mode in `run.ts`, for serve/mcp in `callWorkflow`) that escalates through `killProcessTree`, plus an optional max-step circuit breaker in the runtime.

### Acceptance criteria
- A host/`--unsafe` run that exceeds a configured wall-clock timeout is terminated without requiring Ctrl-C; a test asserts the parent kills the child after the budget.
- The same timeout applies to serve/mcp workflow calls (or is documented as shared); a test covers at least one of those paths.
- An optional max-step / max-iteration circuit breaker stops a runaway workflow; a test asserts the run ends when the cap is hit.
- Docker-mode timeout behaviour remains intact; a regression test still asserts the Docker timeout path.

## Pin an explicit OIDC JWT algorithms allowlist in `jwtVerify` #dev-ready

Context: ASI-08, LOW, confidence 0.72. Finding L-3 — OIDC `jwtVerify` pins no explicit `algorithms` allowlist (defense-in-depth).

Problem: `jwtVerify(token, keys, { issuer, audience })` is called with no `algorithms` option (`auth.ts:227`). Not exploitable today: `jose` rejects `alg:none` and type-matches the JWK to the algorithm, so RS256↔HS256 confusion is not reachable with a remote JWKS. Still worth pinning `algorithms: ["RS256","ES256", …]` to constrain future key-type/JWKS changes.

Location: `src/cli/serve/auth.ts:227`.

Remediation: add an explicit `algorithms` allowlist matching the IdP's signing algorithms.

### Acceptance criteria
- `jwtVerify` is invoked with a non-empty `algorithms` allowlist that includes the supported asymmetric algorithms (at least RS256 and ES256, or the project's chosen set); a test asserts the options object includes `algorithms`.
- A token whose `alg` is outside the allowlist is rejected; a test asserts 401 (or the existing invalid-token mapping) for a disallowed algorithm.
- Valid tokens signed with an allowed algorithm still authenticate; a regression test asserts success for the existing OIDC happy path.

## Use `npm ci` and exact-pin the runtime dependency in local builds #dev-ready

Context: ASI-09, LOW, confidence 0.72. Finding L-4 — caret dependency ranges and `npm install` (not `ci`) in the local build path.

Problem: `package.json` uses caret ranges (`jose: ^5.10.0`, caret-ranged dev deps); the local-source installer runs `npm install` (`docs/install`), not `npm ci`. `package-lock.json` pins transitively and no `@latest` is used (good), but caret ranges plus `npm install` weaken lock enforcement versus a clean-room `npm ci`.

Location: `package.json:34-41`; `docs/install` (local-source / install-from-local path).

Remediation: use `npm ci` in the local build path and consider exact-pinning the single runtime dependency.

### Acceptance criteria
- The local-source install/build path runs `npm ci` (not bare `npm install`) when a lockfile is present; a test or script assertion covers that command choice.
- The runtime dependency `jose` is exact-pinned (no caret/`^`) in `package.json`; a test or fixture asserts the version string has no range operator.
- A clean checkout with an intact `package-lock.json` still installs and builds successfully after the change.
