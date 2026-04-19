# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.
7. **Before starting any task, read `docs/target-design.md` end-to-end**, including the "Implementation pitfalls observed in the prior attempt" section. Several task descriptions below intentionally repeat points from that section; that is not redundancy, it is reinforcement of contracts the previous pass missed.

***

## Configuration — remove the user-visible Docker mode and language-level sandbox config #dev-ready

**Goal**
Cut sandbox-backend details out of the user-facing surface entirely. Users express orchestration intent through `isolated`; they do not toggle Docker on/off, and they do not see Docker keys in `.jh` config. The previous attempt removed in-`.jh` keys but left the env vars and the whole-program Docker spawn path — finish that cleanup.

**Scope**

* Remove **all** user-visible knobs that toggle whether sandboxing happens:
  - Delete `JAIPH_DOCKER_ENABLED` and any code that reads it.
  - Delete the whole-program Docker spawn path in `src/cli/commands/run.ts` (`if (dockerConfig.enabled) spawnDockerProcess(...)`). `jaiph run file.jh` always runs the orchestrator on the host. Sandboxing happens per-call via `run isolated`.
  - Delete `--raw` mode in `cli/commands/run.ts` if its only purpose was supporting the inner-container path of whole-program Docker mode.
* Remove language-level `runtime.docker_*` style settings from `.jh` config (the previous attempt did this; verify nothing crept back).
* **Allowed remaining configuration** (host-level env or CLI config, never in `.jh`):
  - `JAIPH_ISOLATED_IMAGE` — the container image used for `run isolated`. Default to the official GHCR image. May be overridden for development.
  - Optional: container network policy, per-call timeout. Both are tuning knobs, not on/off switches.
* Keep only configuration justified by the target design: agent selection, observability, run artifacts, recover loop budget, module metadata.
* `src/runtime/docker.ts` keeps the primitives (overlay script, cap-drop args, env denylist, `spawnDockerProcess`) since the `isolated` task reuses them as the backend. Strip anything that is only used by the deleted whole-program Docker mode (e.g. `findRunArtifacts` if nothing else calls it after this cleanup).

**Required tests**

* Parser / validation tests for removed config keys.
* Test that `JAIPH_DOCKER_ENABLED=true` is not honored — it has no effect on `jaiph run` behavior.
* Test that a workflow with no `run isolated` calls runs entirely on the host (no container spawned).
* Test that a workflow with `run isolated` calls spawns the backend exactly for those calls and no others.
* Docs updates so configuration examples match the reduced surface.

**Acceptance criteria**

* `JAIPH_DOCKER_ENABLED` and the whole-program Docker spawn path are gone.
* `.jh` config no longer exposes sandbox-backend plumbing as authoring surface.
* `JAIPH_ISOLATED_IMAGE` (and any other retained backend-tuning vars) are documented as host-level configuration only.
* No code path treats sandboxing as user-optional. `run isolated` always sandboxes; absence of the keyword always doesn't.
* Docs and tests match the reduced config model.

## Productization — rewrite the built-in orchestration workflows to the new model #dev-ready

**Goal**
Prove the redesign is usable by migrating the built-in Jaiph orchestration files to it, especially `.jaiph/engineer.jh`.

**Scope**

* Update `.jaiph/engineer.jh` to use the new async-handle, isolated-branch, join/apply shape with the candidate-join pattern.
* Update other built-in `.jaiph/*.jh` workflows only where needed to keep the shipped experience coherent.
* Keep the migration narrow. Do not expand this task into unrelated product ideas.

**Required tests**

* Update or add focused tests that exercise the shipped orchestration path.
* Verify docs/examples align with what ships.

**Acceptance criteria**

* `.jaiph/engineer.jh` demonstrates the new model rather than the old one.
* The built-in workflow experience is coherent end-to-end.

## Cleanup — remove the target design document after the rewrite lands #dev-ready

**Goal**
`docs/target-design.md` is a temporary planning artifact. Once the rewrite is implemented and the real docs are updated, remove it.

**Scope**

* Delete `docs/target-design.md`.
* Ensure the permanent docs fully cover the shipped model before deletion.
* Before deleting, decide explicitly what to do with the "Implementation pitfalls observed in the prior attempt" section: fold the still-relevant points into `CONTRIBUTING.md` / a permanent design page, or drop them as historical. Do not silently lose them by deleting the file.
* Remove stale references to the temporary design page.

**Acceptance criteria**

* `docs/target-design.md` is deleted.
* Permanent docs stand on their own without referring readers to the temporary design document.

***
