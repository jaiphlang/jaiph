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

## Fix: Ship a tailored AppArmor profile for overlay mode

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 3 (LOW, ASI-03/ASI-05) — the tracked exception left by "Prefer `copy` over elevated overlay defaults; document overlay capability posture" (overlay default kept; posture documented in `docs/sandboxing.md#overlay-capability-posture` and locked by tests in `src/runtime/docker.test.ts`).

**Problem:** Overlay mode on Linux runs with `--security-opt apparmor=unconfined` because default host AppArmor profiles deny fuse mounts inside containers, and Docker can only reference profiles already loaded on the host — which the unprivileged CLI cannot do. Unconfined is broader than the fuse mount requires.

**Required behavior:**

* Ship a loadable AppArmor profile (docker-default semantics plus `mount fstype=fuse`) under `runtime/`, with a documented `apparmor_parser` install step for hosts that opt in.
* When that profile is loaded on the host, `buildDockerArgs` prefers `--security-opt apparmor=<profile>` for overlay containers; when it is not loaded, fall back to `apparmor=unconfined` (current posture) so overlay keeps working out of the box.
* Update the overlay posture section in `docs/sandboxing.md` and the posture-lock tests in `src/runtime/docker.test.ts` for both branches.

Acceptance:

* Overlay containers use the tailored profile when it is loaded and `unconfined` otherwise, with unit tests covering both branches (profile-detection injectable for tests).
* Docs describe how to load the profile and exactly what it permits beyond docker-default.
* `npm test` passes.

***
