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

## Spec — handle, isolation, and recover composition rules #dev-ready

**Goal**
Lock down the value model and composition rules from `docs/target-design.md` as a written specification before any runtime code changes. This task ships only docs and tests; no production behavior changes.

**Scope**

* Write a precise spec section (in `docs/target-design.md` or a sibling `docs/spec-async-isolated.md`) covering:
  - `Handle<T>` value model: a handle resolves to whatever the called function returned. First non-passthrough read forces resolution. Passthrough (assignment, storage, passing through arguments and returns unchanged) does not.
  - Workflow exit implicitly joins remaining unresolved handles; not an error.
  - `run isolated` inside an already-isolated execution context is a compile-time error, **including transitively** (i.e. `run isolated A` where A calls B where B calls `run isolated C` is also a compile-time error). The check walks the static call graph, not just the immediate target.
  - Calls inside an isolated body run in the same sandboxed context; there is no nested isolation.
  - `recover` for an isolated async branch runs inside the branch's sandboxed context, retries inside the branch, and the coordinator only observes the final result.
  - `recover` for non-isolated `run` runs in the current workspace.
  - **`isolated` is an OS-level isolation contract**, not a workspace-write convention. The spec must enumerate what `isolated` guarantees: read-only host filesystem (except a designated writable workspace), separate PID/mount/network namespaces, no inherited host credentials (env denylist), no escape via `kill $PPID` or writing outside the designated workspace.
  - **The v1 backend is fixed: Docker + fuse-overlayfs, reusing `src/runtime/docker.ts`.** The spec must say so explicitly. Other backends (Podman, Firecracker, gVisor, microVM CLIs) are not part of v1 and are not authoring surface either way. `git worktree` is intentionally not part of the design — record the decision and the reason (requires git in host and container, doesn't apply to non-git workspaces, adds per-call host-side lifecycle the overlay backend doesn't need).
  - `ensure` is removed; `rule` is removed.
* Capture every rule above as a planned test name (compile-time error tests, runtime resolution tests, recover-loop tests, **isolation containment tests**). Implementation of those tests lands in the corresponding later tasks.

**Required tests**

* No production tests in this task. The deliverable is the spec plus a checklist of test names that later tasks will fulfill.

**Acceptance criteria**

* Spec section exists, is referenced from the rest of `docs/target-design.md`, and is internally consistent.
* Every composition rule has a named placeholder test it expects later tasks to add.
* The spec explicitly documents the OS-level isolation contract for `isolated`. "Workspace-scoped convention" is not allowed as a definition.
* The spec explicitly states that the v1 backend is the existing Docker + fuse-overlayfs implementation in `src/runtime/docker.ts`, reused (not rewritten), and that no `git worktree` layer is added.

## Language/Runtime — add `recover` loop semantics for non-isolated `run` #dev-ready

**Goal**
Add `recover` as a first-class repair-and-retry primitive distinct from `catch`. Ship for non-isolated, non-async `run` first. Async + isolated composition lands in the `async` task, not here.

**Scope**

* Keep existing `catch` behavior as one-attempt try/catch.
* Add:

  ```jh
  run sth() recover(err) {
    ...
  }
  ```

  with loop semantics: try, bind failure, run repair block, retry, stop on success or retry-limit exhaustion.
* Add a small explicit retry limit (default 10) with config override.
* Keep the runtime behavior simple and observable; do not introduce speculative control-flow abstractions.

**Required tests**

* Parser / formatter / validation coverage for `recover`.
* Runtime tests for:
  - success on first attempt
  - one or more repair loops before success
  - retry limit exhaustion
  - retry limit configured via `config`
* At least one acceptance test using `recover` to repair and retry a failing run.

**Acceptance criteria**

* `recover` is distinct from `catch`.
* The retry limit is explicit and configurable.
* Tests prove loop behavior and limit handling.
* The docs-site Jaiph syntax highlighter (`docs/assets/js/main.js`, the `STATEMENT_KEYWORDS` set and any keyword-flow special cases) recognizes `recover` as a keyword. Any `.jh` code block on the docs site that uses `recover` renders with the keyword colored.

## Runtime — add `isolated` as a run-level primitive with OS-level isolation #dev-ready

**Goal**
Match the spec: `run isolated foo()` runs `foo` in a sandboxed execution context that genuinely isolates it from the host. Workspace-write isolation alone is **not acceptable** — see the lessons section above. The user-facing surface is one keyword: `isolated`. There is no opt-in/opt-out switch.

**Scope**

* Implement `run isolated ...` as a run-level primitive in the runtime and CLI launch path.
* **The backend is the existing Docker + fuse-overlayfs implementation in `src/runtime/docker.ts`. Reuse it; do not write a new one.** That file already provides the overlay mount, capability drops (`--cap-drop ALL` + `SYS_ADMIN` only), `--security-opt no-new-privileges`, the credential env denylist, the host-path mount denylist, and the separate `:rw` run-artifacts directory. The work in this task is plumbing it as a per-call backend for `run isolated`, not implementing a new sandbox.
* **No new backends, no `git worktree` layer.** `git worktree` is intentionally out of scope: it requires git in host and container, doesn't apply to non-git workspaces, and adds a per-call host-side lifecycle the overlay backend doesn't need. If diff cleanliness is a problem, fix it in `workspace.export_patch` (filter the diff), not by changing the backend.
* **Banned alternatives** (do not implement; reject in review): `mkdtempSync` + `cpSync`, `cp -r`, "temporary directory copy," bare `git worktree add`, any new container backend (Podman, Firecracker, gVisor) — all out of scope for this task. The single backend is fuse-overlayfs in Docker, as already shipped.
* The user surface is exactly one keyword: `isolated`. There is **no** `JAIPH_DOCKER_ENABLED`-style switch, no `--no-docker` flag, no `runtime.sandbox = false` knob. If the host cannot provide fuse-overlayfs in Docker, `run isolated` is a hard error at run time with an actionable message ("isolated execution requires fuse-overlayfs in Docker; install Docker / load the fuse module").
* **Tightenings to the existing `src/runtime/docker.ts` code, required by this task:**
  - **Remove the rsync / `cp -a` fallback chain** in the overlay script (currently lines ~336–376 of `src/runtime/docker.ts`) for the `run isolated` code path. Missing fuse-overlayfs is a hard error per the spec, not a quiet copy. Whether the existing whole-program Docker mode keeps the fallback is moot, because the `config cleanup` task deletes that path entirely.
  - Wire the per-call invocation: each `run isolated foo()` invocation spawns a container, runs `foo` inside it, captures its return value (or exported artifacts) via the `:rw` run-artifacts mount, and tears down. Multiple `run async isolated × N` spawns N containers in parallel.
  - Per-branch run-artifacts dir: each isolated call gets `.jaiph/runs/<run_id>/branches/<branch_id>/` (already the established convention), mounted at the existing `/jaiph/run` container path.
* **Allowed configuration** (host-level only, never in `.jh`):
  - container image name via `JAIPH_ISOLATED_IMAGE`, defaulting to the official GHCR image (the existing `runtime.docker_image` default carries over)
  - optionally: container network policy and per-call timeout (the existing `runtime.docker_network` and `runtime.docker_timeout` carry over as host-level env)
  - **not allowed**: any flag that disables isolation, falls back to a weaker backend, or makes isolation user-optional
* Each isolated call gets:
  - a writable workspace via fuse-overlayfs upper layer; host workspace mounted at `/jaiph/workspace-ro:ro` (already implemented), merged view at `/jaiph/workspace`
  - a writable run-artifacts directory at `/jaiph/run` (already implemented)
  - the credential env denylist already enumerated in `ENV_DENYLIST_PREFIXES` (already implemented; verify it still covers the spec's prefix list and add any missing)
  - a separate PID namespace (Docker default; verify, do not assume)
* Calls made *inside* an isolated body execute in the same container (no double-isolation overhead).
* Enforce nested-isolation as a compile-time error **transitively**: walk the static call graph from the isolated callsite. If any reachable workflow contains another `run isolated`, fail with a clear error pointing at both call sites. Add a runtime guard as defense in depth: if `executeIsolatedRunRef` is invoked while already inside an isolated context (detected via an env sentinel like `JAIPH_BRANCH_ID`), fail loudly.

**Required tests**

* **Containment tests (e2e, must execute against a real backend; skip-with-explicit-error if backend unavailable)**:
  - `isolated-cannot-write-host-workspace`: branch writes to a file under the coordinator workspace path; after the branch exits, the coordinator workspace is unchanged.
  - `isolated-cannot-read-host-secret`: a sentinel file is placed at `$HOME/.jaiph-isolation-canary` containing a known string before the test; the branch attempts to read it and emit its contents; the test asserts the branch could not read the string.
  - `isolated-cannot-kill-coordinator`: branch attempts `kill -9 $PPID` (or equivalent for the orchestrator's pid); the coordinator survives and the branch's attempt fails or is no-op.
  - `isolated-env-denylist`: coordinator process has `AWS_SECRET_ACCESS_KEY=canary-value` set; the branch reads its env and emits it; the test asserts the value is not present.
  - `isolated-writable-workspace`: branch writes to a file inside its designated workspace; the file is visible inside the branch but not at the corresponding host path.
  - `isolated-export-survives-teardown`: branch creates a file in its run-artifacts directory (`workspace.export_patch` style); coordinator can read it after the branch exits.
* **Composition tests**:
  - `nested-isolated-direct-is-compile-error`: `run isolated A` where A directly contains `run isolated B`. Compile fails.
  - `nested-isolated-transitive-is-compile-error`: `run isolated A` where A → B → C and C contains `run isolated D`. Compile fails. **This case must be in the test suite; the previous attempt only covered the direct case.**
  - `nested-isolated-runtime-guard`: even if the static check is bypassed (e.g. via dynamic dispatch), the runtime fails when `executeIsolatedRunRef` runs inside an active isolated context.
  - `isolated-non-isolated-inner-call-shares-context`: a non-isolated `run` inside an isolated body executes in the same sandboxed context (verified by inspecting environment, PID namespace, or filesystem identity).
* **Backend availability**:
  - `isolated-fails-without-backend`: with the backend disabled or unavailable, `run isolated` returns a clear error referencing how to install/start the backend. There is no silent fallback.

**Acceptance criteria**

* `run isolated ...` provides genuine OS-level isolation per the spec.
* All six containment tests pass on CI against a real backend.
* The user surface is exactly the `isolated` keyword. No env or config makes isolation optional or weaker.
* Nested-isolation compile error fires transitively (not only on the immediate target). Runtime guard exists as defense in depth.
* `mkdtempSync` + `cpSync` does not appear anywhere in the isolated execution path.
* The fuse-overlayfs path in `src/runtime/docker.ts` is reused, not duplicated. No second sandbox implementation is introduced. No `git worktree` layer is introduced.
* The rsync / `cp -a` fallback chain in the overlay script is removed for the `run isolated` path (or the whole script, if the `config cleanup` task already removed the whole-program Docker mode that depended on it).
* User-facing docs describe `isolated` as the language contract; Docker + fuse-overlayfs is mentioned only as the v1 implementation backend and as a host requirement.
* The docs-site Jaiph syntax highlighter (`docs/assets/js/main.js`) recognizes `isolated` as a keyword. Code blocks containing `run isolated foo()` render with `isolated` colored.

## Runtime — redesign `run async` around handles with transparent resolution, including `recover` composition #dev-ready

**Goal**
Match the async contract in the spec: `run async` returns a handle immediately, the handle resolves on first non-passthrough read, and the workflow exit implicitly joins any remaining unresolved handles. **Also ship `recover` composition for async (with and without `isolated`)** — this is the piece the previous attempt missed.

**Scope**

* Replace the current implicit end-of-workflow join in `src/runtime/kernel/node-workflow-runtime.ts` with a value-based handle model.
* `run async ...` returns a `Handle<T>` value. `T` is the same return type the function would have under a non-async `run`.
* Reads that force resolution: passing as an argument to `run`, string interpolation, comparison, conditional branching, any other access to the underlying value.
* Passthrough (assignment, storing in a list, passing through `workflow` arguments and returns unchanged) does not force resolution.
* Workflow exit implicitly joins unresolved handles. This is not an error; it preserves today's end-of-workflow behavior at the boundary.
* No fire-and-forget mode.
* **`recover` composition with async (this was the missed piece):**
  - `b1 = run async foo() recover(err) { ... }` — handle resolves to either the eventual success value (after retry loop runs in the coordinator workspace) or the final failure.
  - `b1 = run async isolated foo() recover(err) { ... }` — recover block runs **inside the branch's sandboxed context**. `foo` retries inside the same context. The coordinator observes only the final outcome. Recover blocks for isolated branches cannot mutate the coordinator workspace.
  - Parser must accept `recover(err) { ... }` after both `run async ref(args)` and `run async isolated ref(args)`. The previous attempt had the parser silently reject these with a "trailing content" error — that is the failure mode to fix.
  - Same retry-limit semantics as non-async `recover`.
* Preserve async progress/event visibility unless the contract forces an intentional change.
* Update docs that still describe the old statement-based async model.

**Required tests**

* Parser / formatter / validation coverage for `run async [isolated] ref(args) recover(err) { ... }`.
* Runtime tests for handle creation, transparent resolution at first read, and resolution forced by passing a handle into another `run`.
* Runtime test for the candidate-join shape: multiple async handles passed into another call all resolve before the callee runs.
* Runtime test that workflow exit joins unresolved handles without raising an error.
* Runtime test that handles can be stored in a list and resolved when read.
* **The four spec-named recover-composition tests, all must pass:**
  - `recover-isolated-runs-in-branch` — recover block executes inside the branch's sandboxed context, not on the coordinator.
  - `recover-isolated-retries-in-branch` — retry after recover executes inside the same branch context (verified by inspecting filesystem state or env between attempts).
  - `recover-isolated-coordinator-sees-final-only` — coordinator observes only the final result, not intermediate failures.
  - `recover-isolated-no-coordinator-mutation` — recover block cannot mutate coordinator workspace.

**Acceptance criteria**

* `run async ...` returns a first-class handle value.
* Handle reads force resolution per the spec.
* Workflow exit implicitly joins remaining handles.
* `recover` works on `run async ref()` and `run async isolated ref()`. The parser accepts both forms; the runtime implements the spec contract for both.
* All four named recover-composition tests pass.
* Docs and tests match the new contract.
* The docs-site Jaiph syntax highlighter (`docs/assets/js/main.js`) recognizes `async` as a keyword (modifier on `run`) and continues to highlight `recover` correctly when it appears as `recover(err) { ... }` after `run async ref(args)` or `run async isolated ref(args)`. A docs code block with `b1 = run async isolated foo() recover(err) { ... }` renders with `run`, `async`, `isolated`, and `recover` all colored.

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
