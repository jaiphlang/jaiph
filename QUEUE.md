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

## Make release-install and runtime-image toolchain verification fail-closed #dev-ready

Context: ASI-09, MEDIUM, confidence 0.80. Finding M-11 — release-install verification is fail-open and the runtime image pulls toolchains without checksums.

Problem: The release binary's minisign signature is checked only when `minisign` is on PATH; otherwise the installer warns and continues (`docs/install:242-256`), so a default host with no minisign degrades to checksum-only — and the checksum arrives from the same channel as the binary. `JAIPH_RELEASE_BASE_URL` / `JAIPH_MINISIGN_PUBLIC_KEY` are overridable and an empty key silently skips verification (`docs/install:213,242-243`). The bootstrap pipes an unsigned script to `bash` with an env-overridable origin (`use.ts:37-42`, `docs/run`). The runtime image fetches/executes toolchain installers (uv/rustup/bun/cursor-agent checksum ARGs default to `""` → skip; go/yq/kubectl/aws-cli/go-task fetched with no checksum) in `runtime/Dockerfile`. An attacker compromising the GitHub Release (or the channel via `JAIPH_RELEASE_BASE_URL`) can replace the binary and `SHA256SUMS` consistently and pass the checksum without the signature ever being checked; a compromised toolchain CDN poisons default runtime-image builds.

Location: `docs/install:213`, `:242-256`; `src/cli/commands/use.ts:37-42`; `runtime/Dockerfile`.

Remediation: Make signature verification mandatory for non-CI installs (bootstrap a pinned verifier, or treat "minisign unavailable" as fail-closed); publish and check a hash/signature of the install script itself; treat an empty `JAIPH_MINISIGN_PUBLIC_KEY` as fail-closed, not skip; populate and require the Dockerfile SHA-256 ARGs and add `sha256sum -c` for go/yq/kubectl/aws/task.

### Acceptance criteria
- A non-CI install with `minisign` unavailable fails closed rather than continuing on checksum-only; a test/harness asserts the installer aborts.
- An empty `JAIPH_MINISIGN_PUBLIC_KEY` causes verification to fail closed, not skip; a test asserts the abort.
- The runtime `Dockerfile` requires a non-empty SHA-256 for each toolchain fetch (uv/rustup/bun/cursor-agent and go/yq/kubectl/aws-cli/go-task) and runs `sha256sum -c`; a build with a mismatched/empty checksum fails.
- The install/bootstrap script's own integrity is verified before execution (hash/signature check); a test/harness asserts a tampered script is rejected.

## Broaden and canonicalise credential redaction #dev-ready

Context: ASI-06, MEDIUM, confidence 0.85. Finding M-5 — redaction misses common secret names and is literal-substring only.

Problem: `redactCredentials` fires only for env keys ending in one of four suffixes (`CREDENTIAL_KEY_SUFFIXES = ["_API_KEY","_TOKEN","_SECRET","_API_TOKEN"]`, `redact.ts:9`, `:11-14`), so it silently misses `AWS_SECRET_ACCESS_KEY` (ends `_ACCESS_KEY`), `AWS_ACCESS_KEY_ID`, `*_SECRET_KEY`/`STRIPE_SECRET_KEY`, `*_PASSWORD`/`PASSWORD`, `PASSPHRASE`, `*_PRIVATE_KEY`, `*_CREDENTIALS`, and password-bearing `DATABASE_URL`. Even for matched keys it is an exact-literal substring replace with a `< 8` char floor (`:17-24`), so base64/URL-encoding/hex/JSON-escaping or a secret split across chunks evades it, and short secrets are never redacted. The same `redactCredentials` feeds the journal, OTLP (`otlp.ts`), Sentry (`sentry.ts`), and `/v1/runs/{id}/events` (`handler.ts`) — exactly where operators are told to expect `[REDACTED]`.

Location: `src/runtime/kernel/redact.ts:9`, `:11-14`, `:17-24`.

Remediation: Broaden detection well beyond four suffixes (`_ACCESS_KEY`, `_SECRET_KEY`, `PASSWORD`, `PASSPHRASE`, `PRIVATE_KEY`, `CREDENTIAL(S)`, `_PAT`, `_DSN`, and substring `SECRET`/`PASSWORD`/`TOKEN`), add canonicalisation passes for base64/hex/url-encoded forms of known values, drop or lower the 8-char floor, and document the literal-substring limit as an explicit non-guarantee.

### Acceptance criteria
- `isCredentialKey` matches `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `STRIPE_SECRET_KEY`, `DB_PASSWORD`, `PASSPHRASE`, `SSH_PRIVATE_KEY`, and `SERVICE_CREDENTIALS`; a test asserts each is detected.
- A base64-encoded form of a known secret value is redacted in output; a test asserts the encoded form is caught.
- The 8-char floor is removed or lowered so short secrets are redacted; a test asserts a short known secret is redacted.
- Redaction improvements apply uniformly across journal, OTLP, Sentry, and `/events`; a test asserts a newly-detected secret is redacted on at least the `/events` path.

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
