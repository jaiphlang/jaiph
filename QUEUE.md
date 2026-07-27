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
