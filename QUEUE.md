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
