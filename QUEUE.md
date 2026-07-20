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

## Feat: Hash-chain `run_summary.jsonl` and redact secrets in run artifacts #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 4 (LOW, ASI-06).

**Problem:** Structured run events are written under `.jaiph/runs` (mounted writable at `/jaiph/run` inside the sandbox). There is no hash chain, so a misbehaving agent can rewrite its own audit trail. Prompt/command artifacts persist interpolated secrets in cleartext.

**Required behavior:**

* Each `run_summary.jsonl` line includes a hash of the previous line’s payload (or a running chain field) so truncation/rewrite is detectable by a verifier.
* Ship a small verify helper or `jaiph` subcommand/docs recipe that validates the chain for a run dir.
* Redact values of known credential env keys (the Docker allowlist / backend credential names) from persisted prompt bodies and reconstructed command lines before write.
* Document the chain format and redaction scope in architecture or artifacts docs.

Acceptance:

* Unit test: append two events, tamper with the first line on disk, verifier fails; untampered chain passes.
* Unit test: artifact write path redacts a fixture `ANTHROPIC_API_KEY` (or equivalent) value present in prompt text.
* Docs describe the chain field and how to verify.
* `npm test` passes.

***

## Feat: Sign release checksums and pin Dockerfile toolchain installers #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 5 (LOW, ASI-09).

**Problem:** `docs/install` verifies SHA-256 against `SHA256SUMS` from the same origin (TOFU, no detached signature). `runtime/Dockerfile` installs toolchains via unpinned `curl | sh`/`bash`.

**Required behavior:**

* Publish and verify a detached signature over `SHA256SUMS` (cosign or minisign — pick one and document) in the install scripts.
* Pin toolchain installers in `runtime/Dockerfile` to known content hashes (or fixed version URLs + checksum verify) before execute; no raw pipe-to-shell without verification.
* Document the trust model in contributing/release docs.

Acceptance:

* Installer fails closed when the signature is missing or invalid (tested with a fixture or mocked download in CI where feasible).
* Dockerfile build path does not execute unverified remote install scripts (grep/test lock).
* Docs describe how releases are signed and how users verify.
* Relevant CI / `npm test` hooks pass.

***

## Fix: Lock `agent.command` / `agent.backend` against untrusted imported module metadata #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 6 (LOW, ASI-03/ASI-09).

**Problem:** `applyMetadataScope` can set `JAIPH_AGENT_COMMAND` from an imported module’s metadata unless `JAIPH_AGENT_COMMAND_LOCKED=1`. A third-party `.jh` library can therefore change which binary the cursor backend spawns for `prompt` steps without attestation.

**Required behavior:**

* Imported-module metadata must **not** override `agent.command` / `agent.backend` (and equivalent env keys) by default.
* Only the entry module’s config (or an explicit unlock / allowlist flag documented for advanced use) may set those keys for the run.
* Existing `*_LOCKED` gates remain; defaults become safe without requiring the caller to pre-lock.

Acceptance:

* Test: entry workflow imports a module that sets `agent.command` to a distinct binary; prompt execution still uses the entry/default command unless explicitly opted in.
* Test: entry module setting `agent.command` still works.
* Docs note the trust boundary for execution-config keys on import.
* `npm test` passes.

***

## Fix: Forward only backend-specific credential env keys into the Docker sandbox #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 7 (LOW).

**Problem:** `ENV_ALLOW_PREFIXES` forwards entire `ANTHROPIC_*` / `CURSOR_*` / `CLAUDE_*` / `OPENAI_*` / `JAIPH_*` families into the container. Any host secret matching those prefixes is visible to sandboxed code and exfiltratable if prompt→shell injection lands inside the container.

**Required behavior:**

* Forward only the specific keys required by the resolved agent backend (document the allowlist per backend), not whole prefix families — except `JAIPH_*` run-control keys that the runtime itself needs (keep those as a tight enumerated or clearly justified prefix).
* `--env` / explicit passthrough remains an intentional escape hatch and is documented as such.
* Unit tests lock the forwarded key set for each backend.

Acceptance:

* With unrelated `ANTHROPIC_UNUSED=…` on the host and backend=claude, that key is **not** present in the container env in tests.
* Required keys for the active backend still forward.
* Docs list per-backend credential keys and the `--env` bypass.
* `npm test` passes.

***

## Fix: Prefer `copy` over elevated overlay defaults; document overlay capability posture #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 3 (LOW, ASI-03/ASI-05).

**Problem:** Overlay mode starts as root with `SYS_ADMIN` and (on Linux) `apparmor=unconfined` to mount fuse-overlayfs, then drops privileges. That is a larger kernel attack surface than `copy` for the same isolation guarantee.

**Required behavior:**

* Re-evaluate default mode selection: prefer `copy` as the default when the isolation guarantee is equivalent, **or** keep overlay only where it is a clear win and document why — but do not leave AppArmor `unconfined` unexplained. If overlay remains default on fuse hosts, add a tailored AppArmor profile (or document tracked follow-up with a linked issue) and surface the elevated posture in sandbox docs.
* Sandbox docs state clearly: overlay elevates during setup; `copy` does not; when to force `JAIPH_DOCKER_NO_OVERLAY=1`.

Acceptance:

* Docs accurately describe overlay caps / AppArmor / UID drop vs copy.
* Either (a) default mode changes to `copy` with tests updated, or (b) overlay default remains but AppArmor is not blanket `unconfined` (profile or explicit tracked exception with test locking the chosen posture).
* `npm test` / relevant e2e sandbox tests pass.

***
