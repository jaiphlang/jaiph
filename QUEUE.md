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

## Runtime — explicit branch outputs and join/apply path #dev-ready

**Goal**
Make candidate-style orchestration real with explicit user-named exports. The runtime provides fan-out, isolation, and result-passing plus a writable outputs location per branch. It does not provide diff merging or candidate selection logic; those are user code (typically LLM-driven inside the join workflow).

**Scope**

* Provide a writable outputs location inside each isolated workspace at a stable path under `.jaiph/runs/<run_id>/branches/<branch_id>/`. The location must survive container teardown and be readable from the coordinator.
* Add two standard-library primitives:
  - `workspace.export_patch(name)` — packages the branch's git changes into a patch file at `.jaiph/runs/<run_id>/branches/<branch_id>/<name>` and returns the absolute path string.
  - `workspace.export(local_path, name)` — copies a file from `local_path` inside the branch workspace to `.jaiph/runs/<run_id>/branches/<branch_id>/<name>` and returns the absolute path string.
* Branch handles resolve to whatever the function returned. There is no runtime-injected struct on top.
* Track minimum branch metadata (id, status, exit code, timing) for observability only. Do not expose a `branch.*` user-facing API.
* Add `apply_patch(path)` to the standard library: applies a patch file to the coordinator workspace via `git apply`. Not a language primitive.
* `workspace.export_patch` excludes `.jaiph/` from the diff (both the branch and the coordinator write run artifacts there; including those in the patch would clobber state on apply). **This exclusion must be documented in `docs/libraries.md` and in the workspace.jh inline comment.** The previous attempt shipped the exclusion silently; users will lose changes to `.jaiph/*` from a patch and not know why.
* Implement the chosen mechanism so the following pattern works end-to-end:

  ```jh
  workflow implement_candidate(task, role, patch_name) {
    run implement(task, role)
    return run workspace.export_patch(patch_name)
  }

  workflow default() {
    const task = run queue.get_first_task()

    b1 = run async isolated implement_candidate(task, "surgical",   "candidate_surgical.patch")
    b2 = run async isolated implement_candidate(task, "optimizer",  "candidate_optimizer.patch")
    b3 = run async isolated implement_candidate(task, "stabilizer", "candidate_stabilizer.patch")

    const final = run isolated join_implementations(b1, b2, b3)
    run apply_patch(final)
  }
  ```

* A branch that does not call an export primitive simply returns whatever its function returned. The runtime does not require an export.
* Keep the apply step conservative: a single explicit application step against the coordinator workspace.

**Required tests**

* Runtime tests for `workspace.export_patch` and `workspace.export`: file is created at the expected coordinator-readable path; return value matches that path.
* Runtime test that branch handle return values are the function's return value (string from `export_patch`, anything else for non-exporting branches).
* Acceptance test for the candidate / join / apply shape above.
* Failure-path test when `apply_patch` cannot apply the chosen patch cleanly.
* Test that `workspace.export_patch` excludes `.jaiph/` from the produced patch (write a file under `.jaiph/` inside the branch, export, assert the patch does not reference it).

**Acceptance criteria**

* `workspace.export_patch` and `workspace.export` work and return coordinator-readable paths.
* `apply_patch` works as a standard-library function, not a language primitive.
* Branch handles resolve to plain user-defined return values; no magic struct exists.
* Join and apply work for the baseline candidate pattern.
* The `.jaiph/` exclusion is documented in `docs/libraries.md` and in the workspace.jh source.
* Tests cover both success and at least one conservative failure path, plus the `.jaiph/` exclusion.

## Language/Runtime — add `readonly`, remove `rule`, remove `ensure` #dev-ready

**Goal**
Match the spec: replace `rule` with explicit execution policy and remove `ensure` entirely. Validation-style logic uses `run readonly ...`. `ensure X [catch(err) {...}]` becomes `run X [catch(err) {...}]`.

**Scope**

* Add `run readonly ...` semantics.
* Remove `rule` parsing/validation/runtime support.
* Remove `ensure` parsing/validation/runtime support.
* Migrate all in-tree `.jh` files (`.jaiph/*.jh`, `examples/*.jh`, `e2e/*.jh`, `golden-ast/fixtures/*.jh`, `test/fixtures/*.jh`) so they no longer use `ensure` or `rule`. Mechanical replacement: `ensure X` → `run X`, `ensure X catch(err) {...}` → `run X catch(err) {...}`, `rule R(...) {...}` → `workflow R(...) {...}` invoked via `run readonly R(...)`.
* Keep the model explicit and small. Do not invent a replacement primitive besides `readonly`.

**Required tests**

* Parser / formatter / validation updates for removing `rule`, removing `ensure`, and adding `readonly`.
* Runtime tests proving readonly restrictions (mutation attempts inside `run readonly ...` must fail).
* Acceptance tests showing `run readonly ...` as the validation path.
* Snapshot/e2e tests covering migrated `.jh` files still pass.

**Acceptance criteria**

* `rule` is removed.
* `ensure` is removed.
* `run readonly ...` works as the replacement execution policy.
* All in-tree `.jh` files compile and run without `ensure` or `rule`.
* Docs and tests no longer describe `rule` or `ensure` as live primitives.
* The docs-site Jaiph syntax highlighter (`docs/assets/js/main.js`) is updated in lockstep: `readonly` is added to `STATEMENT_KEYWORDS`; `rule` and `ensure` are removed from `STATEMENT_KEYWORDS` **and** from the keyword-flow special cases (the branches that special-case `firstValue === "rule"`, `firstValue === "ensure"`, etc.). Any leftover `rule`/`ensure` code paths in the highlighter are deleted, not left as dead code.

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
