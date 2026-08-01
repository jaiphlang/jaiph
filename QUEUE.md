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

## Make serve anonymous loopback auth an explicit opt-in #dev-ready

Context: Security review 2026-07-31, finding M-2 (ASI-04/ASI-07), severity MEDIUM, confidence 0.8. When neither `JAIPH_SERVE_TOKEN` nor OIDC is configured, `serve` runs in auth mode `none` on loopback with no warning.

Problem: In mode `none`, every request is authorized as an anonymous principal holding all capabilities (`invoke`, `inspect`, `cancel`) over all runs. On a shared or multi-user host, any other local user or process can `POST http://127.0.0.1:5247/v1/workflows/{name}/runs` or hit `/mcp` and execute arbitrary exposed workflows and read every run's artifacts — loopback is a boundary against the network, not against other local users. Only a non-loopback bind without auth is currently a startup error.

Location: `src/cli/serve/auth.ts:99-101` (`openPrincipal` returns `capabilities: new Set(ALL_CAPABILITIES), ownsAllRuns: true`) and `src/cli/serve/auth.ts:294-303` (mode `none`); guard at `src/cli/commands/serve.ts:171-178`.

Remediation: Require an explicit `--allow-anonymous` flag before binding even loopback with no configured auth; without the flag and without `JAIPH_SERVE_TOKEN`/OIDC, startup fails with an actionable error. When `--allow-anonymous` is passed, log an explicit startup warning that the server is open to all local principals, and document in the serve docs that shared hosts must use `JAIPH_SERVE_TOKEN` or OIDC.

### Acceptance criteria
- `jaiph serve` on loopback with no `JAIPH_SERVE_TOKEN`, no OIDC config, and no `--allow-anonymous` flag exits with a startup error, verified by a test.
- `jaiph serve --allow-anonymous` starts, serves anonymous requests as before, and emits a startup warning about the open-auth posture, verified by a test asserting the warning.
- `serve` with `JAIPH_SERVE_TOKEN` or OIDC configured starts without requiring the flag and behaves as before, verified by existing or new tests.
- Serve documentation states that anonymous mode is single-user-workstation only and shared hosts require token or OIDC auth.

## Store audit chain key outside the run directory and fail closed on key loss #dev-ready

Context: Security review 2026-07-31, finding M-3 (ASI-06 Insufficient Logging), severity MEDIUM, confidence 0.7. The journal's keyed-HMAC tamper evidence can be silently disabled by the workflow it is meant to constrain.

Problem: The per-run HMAC key is persisted as `.chain-key` inside the run directory, which is agent-writable (`$JAIPH_RUN_DIR` for script steps; bind-mounted `rw` at `/jaiph/run` in Docker). A malicious workflow's first script step runs `mkdir "$JAIPH_RUN_DIR/.chain-key"`, squatting the path as a directory; at finalize the host's `writeFileSync` throws `EISDIR`, which `writeChainKey` swallows. `readChainKey` then returns `null`, `verifyRunJournal` fails open (`verified:false, ok:true`), and the workflow can rewrite or delete `run_summary.jsonl` to erase evidence — the mangled journal is still exported to OTLP/Sentry and served over `/v1/runs/{id}/events` with no integrity failure.

Location: `src/runtime/kernel/emit.ts:52-58` (`writeChainKey` swallows all write errors) and `src/runtime/kernel/emit.ts:119-124` (`verifyRunJournal` fails open when no key is present); host call sites `src/cli/exec/call.ts:248` and `src/cli/commands/run.ts:637` write `.chain-key` into the run directory.

Remediation: Store the chain key outside the agent-writable run directory (a host-side sidecar keyed by run id, e.g. under the operator's `.jaiph` state root that is never mounted into the container). Make `writeChainKey` failure a hard error instead of best-effort. For runs launched with a host key, treat a missing key at verify/export time as an integrity failure (fail closed) rather than "not verified".

### Acceptance criteria
- The chain key file is no longer written under the run directory; a test asserts the run directory contains no `.chain-key` after a completed run and that the key exists in the host-side location.
- A test simulating the squat (pre-creating a directory at the old in-run-dir key path) shows key persistence and journal verification unaffected.
- A failure to persist the chain key surfaces as a hard error, verified by a test that forces the write to fail.
- For a run that was launched with a chain key, `verifyRunJournal` (and the OTLP/Sentry/serve export boundaries) reports an integrity failure when the key is missing at verification time, verified by a test.

## Commit journal length or terminality so truncated chains fail verification #dev-ready

Context: Security review 2026-07-31, finding L-3 (ASI-06), severity LOW, confidence 0.7. The hash chain commits to prefix integrity but not to length or terminality. Complements M-3 (chain-key squat / fail-open).

Problem: `verifyRunSummaryChain` (`emit.ts:81-106`) iterates only the lines present — no terminal-marker check, no committed line count. Deleting the last *K* lines of a terminal journal leaves a shorter but still internally-valid chain that verifies `ok:true`. During-run truncation is caught (later kernel appends break the chain), so standalone exploitation needs post-terminal filesystem access — but once the key is gone (M-3 fail-open), truncation is trivially undetectable.

Location: `src/runtime/kernel/emit.ts:81-106` (`verifyRunSummaryChain`).

Remediation: Record a terminal event (e.g. `WORKFLOW_END`) and verify its presence, and/or commit a signed line count, so a truncated-but-valid prefix is rejected.

### Acceptance criteria
- A journal whose last lines were deleted after a successful terminal run fails verification (`ok:false` or equivalent integrity failure); a test asserts truncation is rejected.
- A complete terminal journal with an intact `WORKFLOW_END` (or signed line count) still verifies successfully; a test asserts the happy path.
- During-run appends that break the chain continue to fail verification; a regression test covers that case.

## Pin runtime Dockerfile base images and global npm installs #dev-ready

Context: Security review 2026-07-31, finding L-4 (ASI-09), severity LOW, confidence 0.75. Unpinned base images and global npm installs weaken runtime-image provenance.

Problem: `runtime/Dockerfile` uses `FROM node:22-bookworm-slim` and `FROM ubuntu:24.04` by tag (not digest), and runs unpinned `npm install -g pnpm yarn` / `npm install -g @anthropic-ai/claude-code`. Direct toolchain downloads already go through `runtime/fetch-verify.sh` with pinned SHA-256; the registry-sourced layers are the weaker link.

Location: `runtime/Dockerfile:1`, `:13`, `:91`, `:215`; `runtime/fetch-verify.sh`.

Remediation: Pin base images by digest and pin the global npm installs to exact versions (ideally with an integrity check), so the built image is reproducible and its inputs are attested.

### Acceptance criteria
- Every `FROM` in `runtime/Dockerfile` references an image by `@sha256:` digest (or an equivalent pinned digest form); a test or CI check asserts no bare mutable tags remain on `FROM` lines.
- Global `npm install -g` invocations pin exact package versions; a test or CI check asserts version pins are present.
- A runtime image build with the pinned inputs still succeeds (documented or exercised in CI).

## Verify per-library registry signatures only against the embedded key #dev-ready

Context: Security review 2026-07-31, finding L-5 (ASI-05), severity LOW, confidence 0.7. Per-library registry signature is self-authenticating when the entry supplies its own public key.

Problem: `install.ts:199-208` verifies `spec.signature` against `spec.signaturePublicKey ?? EMBEDDED_REGISTRY_PUBKEY`, and `signaturePublicKey` comes from the registry entry itself (`registry.ts:194,212-213`). An entry that supplies its own `publicKey` plus a `signature` over its commit verifies successfully — the signature attests nothing an attacker controlling the entry could not forge. The check is only meaningful against the embedded key. The whole index is already signature-verified against the embedded key (`registry.ts:143`), so this is a false sense of end-to-end attestation rather than a direct break.

Location: `src/cli/commands/install.ts:199-208`; `src/cli/commands/registry.ts:194,212-213`, `:143`.

Remediation: Verify per-library signatures only against the embedded registry key (or a curated set of pinned keys), never against a key supplied by the same entry being verified.

### Acceptance criteria
- A registry entry with a valid signature under an entry-supplied `publicKey` that is not the embedded key is rejected (or the entry key is ignored and verification uses the embedded key only); a test asserts fail-closed or embedded-key-only behaviour.
- A registry entry whose signature verifies against the embedded key still installs successfully; a test asserts the happy path.
- Docs/registry schema no longer imply that a per-entry `publicKey` is a trust anchor for that entry's signature.
