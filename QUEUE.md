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

## Verify per-library registry signatures only against the embedded key #dev-ready

Context: Security review 2026-07-31, finding L-5 (ASI-05), severity LOW, confidence 0.7. Per-library registry signature is self-authenticating when the entry supplies its own public key.

Problem: `install.ts:199-208` verifies `spec.signature` against `spec.signaturePublicKey ?? EMBEDDED_REGISTRY_PUBKEY`, and `signaturePublicKey` comes from the registry entry itself (`registry.ts:194,212-213`). An entry that supplies its own `publicKey` plus a `signature` over its commit verifies successfully — the signature attests nothing an attacker controlling the entry could not forge. The check is only meaningful against the embedded key. The whole index is already signature-verified against the embedded key (`registry.ts:143`), so this is a false sense of end-to-end attestation rather than a direct break.

Location: `src/cli/commands/install.ts:199-208`; `src/cli/commands/registry.ts:194,212-213`, `:143`.

Remediation: Verify per-library signatures only against the embedded registry key (or a curated set of pinned keys), never against a key supplied by the same entry being verified.

### Acceptance criteria
- A registry entry with a valid signature under an entry-supplied `publicKey` that is not the embedded key is rejected (or the entry key is ignored and verification uses the embedded key only); a test asserts fail-closed or embedded-key-only behaviour.
- A registry entry whose signature verifies against the embedded key still installs successfully; a test asserts the happy path.
- Docs/registry schema no longer imply that a per-entry `publicKey` is a trust anchor for that entry's signature.
