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
