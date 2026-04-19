---
title: Target Design
permalink: /target-design
redirect_from:
  - /target-design.md
---

# Target Design

This page describes the intended next Jaiph design, assuming a deliberate breaking reset. Backward compatibility is not a goal. If an existing feature, config surface, or runtime mode makes the language harder to reason about, the target design removes it instead of preserving it.

## Design stance

The target language is smaller and more explicit:

- one way to run a `.jh` file: `jaiph run file.jh`
- one execution primitive: `run`
- execution policy lives on the `run` edge, not in hidden global mode
- sandboxing is a runtime capability, not a separate top-level launch mode
- language constructs that only encode policy and not real semantics should be removed

This is intentionally breaking. Existing Docker-specific launch behavior, `rule` semantics, and config keys tied to the current container implementation should not constrain the redesign.

## Core execution model

The current direction is to make execution policy explicit at the call site:

```jh
run foo()
run readonly foo()
run isolated foo()
run async foo()
run async isolated foo()
```

This is the core simplification.

`async` and `isolated` solve different problems:

- `async` controls scheduling
- `isolated` controls filesystem and process isolation
- `readonly` controls mutation permissions

These modifiers should compose directly instead of being baked into special workflow kinds or top-level CLI modes.

## Isolation is a run-level concern

Isolation should be attached to `run`, not to the callee declaration.

Good:

```jh
run async isolated implement_candidate(task, "surgical")
```

Bad:

```jh
isolated workflow implement_candidate(task) {
  ...
}
```

Making isolation part of the declaration creates hidden behavior. A reader should be able to understand execution semantics from the call site. The same function should be callable in shared, readonly, or isolated mode depending on context, unless the declaration explicitly forbids some modes.

If additional safety is needed, the language can later add declaration-level constraints such as `requires isolated` or `requires readonly`, but these should validate call sites rather than silently changing execution behavior.

## Candidate-join pattern

Jaiph should directly support multi-candidate orchestration as a first-class pattern.

The intended shape is:

```jh
workflow default() {
  const task = run queue.get_first_task()

  b1 = run async isolated implement_candidate(task, "surgical")
  b2 = run async isolated implement_candidate(task, "optimizer")
  b3 = run async isolated implement_candidate(task, "stabilizer")

  const final = run isolated join_implementations(b1, b2, b3)
  run apply_candidate(final)

  run isolated ci.ensure_ci_passes()
  run docs.update_from_task(task)
  run queue.remove_completed_task(...)
  run git.commit(task)
}
```

What the runtime provides:

- safe fan-out into multiple isolated branches with separate workspaces.
- handle-based join semantics so `join_implementations(...)` blocks until all three branches have completed.
- a stable place to persist per-branch outputs via explicit exports, see [Branch outputs](#branch-outputs).
- an apply step that mutates the coordinator workspace from the chosen result.

What the runtime does not provide:

- diff merging.
- "pick the best candidate" logic.

`join_implementations(...)` is user code. In practice it is an LLM-driven decision inside an isolated workspace: read the branch outputs, decide which to keep (or how to combine them), produce a single result. The runtime's job is to make fan-out, isolation, and result-passing trivial; the decision itself stays in the workflow author's hands.

This is stronger than today's single `workspace.patch` model because the runtime can run multiple isolated attempts in parallel and hand them to a deliberate decision step rather than mixing all edits into one sandbox.

## Async contract redesign

> The formal `Handle<T>` value model, resolution semantics, and planned test matrix are in [Spec: Handle, Isolation, and Recover Composition](spec-async-isolated.md).

This design changes the meaning of `run async`.

Today, `run async` means "start concurrently and implicitly join before the enclosing workflow returns." The behavior is preserved at the boundary, but the model becomes value-based instead of statement-based.

The target contract is:

- `run async ...` returns a handle immediately.
- The handle is a first-class value of type `Handle<T>`, where `T` is whatever the called function returns. It is not a special opaque token; it can be assigned, stored in lists, and passed through `task` arguments and returns.
- A handle resolves on its first non-passthrough read. Reading is any operation that needs the value: passing as an argument to `run`, string interpolation `"${h}"`, comparison, conditional branching, or any other access to the underlying value. On read, the runtime blocks until the branch completes and substitutes the resolved value.
- Storing or passing the handle through unchanged is not a read and does not force resolution.
- If the workflow exits with handles still unresolved and unused, the runtime implicitly joins them at exit. Unresolved handles are not an error; they are equivalent to today's end-of-workflow join. There is no fire-and-forget mode.

In practice:

```jh
b1 = run async isolated implement_candidate(task, "surgical")
b2 = run async isolated implement_candidate(task, "optimizer")
b3 = run async isolated implement_candidate(task, "stabilizer")

const final = run isolated join_implementations(b1, b2, b3)
```

When `join_implementations(...)` is invoked, `b1`, `b2`, and `b3` are read (passed as arguments to `run`). The runtime blocks until each branch completes and substitutes the resolved values before the callee executes.

The mental model:

- async creates work.
- handles are futures over that work.
- the first read forces the join; the workflow exit forces any remaining joins.

This contract needs strong automated coverage. The minimum useful test matrix is:

- parser / formatter / validation coverage if syntax changes.
- runtime tests for handle creation, transparent resolution at first read, and the candidate-join pattern with multiple handles passed into another `run`.
- runtime tests for implicit join at workflow exit when handles are still unresolved.
- progress / event coverage if async completion timing changes the emitted shape.

If the redesign cannot be expressed in tests at those layers, the contract is still underspecified.

## Composition rules

The combinators (`async`, `isolated`, `readonly`, `recover`) compose, but the composition has hard rules. The formal specification for these rules — including the `Handle<T>` value model, isolation constraints, and recover semantics — is in [Spec: Handle, Isolation, and Recover Composition](spec-async-isolated.md), which also contains the planned test matrix.

### Nested isolation

Isolation does not nest.

- `run isolated A()` runs `A` in a fresh isolated container. Calls inside `A` (e.g. `run B()`) execute inside that same container; they do not get a new layer of isolation.
- `run isolated B()` appearing inside an already-isolated execution context is a compile-time error. Re-isolating inside an isolated branch is meaningless and almost always a bug.

This keeps the isolation boundary single-layer and easy to reason about: one container per top-level isolated call, period.

### Recover inside isolated branches

`recover` for an isolated async branch runs inside the branch, not on the consumer.

For `b1 = run async isolated foo() recover(err) { ... }`:

- The branch launches in an isolated container.
- The branch runs `foo()` inside that container.
- On failure, the `recover` block runs inside the same isolated workspace. `err` is bound to the failure payload.
- After the recover block completes, `foo()` retries inside the same workspace.
- The loop continues until `foo()` succeeds or the recover retry limit (default 10) is exhausted.
- The handle eventually resolves to either the success result or the final failure. The coordinator never observes intermediate failures.

Implication: recover blocks for isolated branches can mutate the branch workspace freely. They cannot mutate the coordinator workspace. Recover never leaks back across the isolation boundary.

### Recover inside non-isolated runs

For `run foo() recover(err) { ... }` (no `isolated`, no `async`):

- The runtime attempts `foo()`.
- On failure, the recover block runs in the current workspace.
- `foo()` retries.
- Loop until success or retry limit hit.

This is the baseline `recover` behavior and is independent of isolation.

## Branch outputs

Isolated branches expose their outputs by **explicit, named exports**. There is no implicit runtime artifact layer and no magic struct on top of the return value.

The contract:

- A handle resolves to whatever the called function returned. For typical candidate workflows, that is the path string returned by the export primitive.
- The runtime provides a writable outputs location inside each isolated workspace, surviving container teardown and readable from the coordinator.
- The runtime tracks minimum branch metadata (id, status, exit code, timing) for observability only. User code does not consume it.

Two standard-library export primitives:

- `workspace.export_patch(name)` — packages the branch's git changes into a patch file under the run directory and returns its absolute path. The candidate-join workhorse.
- `workspace.export(local_path, name)` — copies an arbitrary file out of the branch workspace into the run directory and returns its absolute path. The escape hatch.

Both write to `.jaiph/runs/<run_id>/branches/<branch_id>/<name>` and return that path as a string.

Example:

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

`b1`, `b2`, and `b3` resolve to plain path strings. `join_implementations` reads three strings, picks one, returns it. `apply_patch` consumes one string and applies it to the coordinator workspace via the standard library — not a new language primitive.

Notes:

- A branch that does not call an export primitive simply returns whatever its function returned. The runtime does not require an export. Validation of branch outputs is the join function's responsibility.
- Branch workspaces and their exports live in `.jaiph/runs/<run_id>/` and follow the same retention policy as other run artifacts. No new lifecycle surface.

## Sandboxing redesign

The target model removes user-visible Docker mode as a language or CLI concern.

Users should not need to think in terms of:

- `runtime.docker_enabled`
- `JAIPH_DOCKER_*`
- `jaiph run --raw`
- whether a whole file is "running in Docker"

Instead, users express intent:

- shared execution
- readonly execution
- isolated execution

### What `isolated` guarantees

`isolated` is an **OS-level isolation contract**, not a workspace-write convention. When a workflow author writes `run isolated foo()`, the runtime must guarantee, for the duration of `foo`'s execution:

1. **Read-only host filesystem.** The host workspace is mounted read-only as the lower layer of an overlay (or equivalent). Writes from inside the branch land in a writable upper layer that is discarded on teardown. The branch cannot modify any file outside its designated writable workspace and its run-artifacts directory.
2. **No host credential leakage.** Environment variables matching `SSH_*`, `AWS_*`, `GCP_*`, `AZURE_*`, `GOOGLE_*`, `DOCKER_*`, `KUBE*`, `NPM_TOKEN` (and any future credential-shaped patterns) are **not** forwarded into the branch.
3. **Separate PID namespace.** `kill $PPID` from inside the branch cannot reach the coordinator process. The branch cannot inspect or signal host processes.
4. **No silent fallback.** If the host cannot provide a backend that satisfies the above, `run isolated` is a hard error at run time with an actionable message ("isolated execution requires a working container runtime; install Docker / fix the daemon"). It does not degrade to a weaker backend without telling anyone.
5. **No on/off switch.** The user-facing surface is exactly one keyword: `isolated`. There is no env var, CLI flag, or config key that disables isolation, makes it optional, or routes `run isolated` through a non-isolating backend. Absence of `isolated` always means non-isolated; presence of `isolated` always means OS-level isolated.

### Backend choice

The implementation mechanism is not part of the language *contract* (the five guarantees above are), but the v1 implementation is fixed: **Docker + fuse-overlayfs, reusing the existing code in `src/runtime/docker.ts`**. The redesign re-wires that backend (per-call invocation for `run isolated`, instead of a whole-program Docker mode) and tightens it (removing the on/off switch and the silent fallback). It does not introduce a second backend.

What that existing code already provides, and what `run isolated` reuses verbatim:

- fuse-overlayfs mount with the host workspace as a read-only lower layer and an in-container writable upper layer, merged at the branch's view of `/jaiph/workspace`
- `--cap-drop ALL` plus only the capabilities fuse-overlayfs requires; `--security-opt no-new-privileges`
- the credential env denylist enumerated above
- a host-path mount denylist (the Docker socket, `/proc`, `/sys`, `/dev`)
- a separate run-artifacts directory (`/jaiph/run`) mounted `:rw` outside the overlay, so exports survive container teardown

What changes from the existing code:

- The whole-program "run the entire `.jh` file inside Docker" launch path is removed. Containers spawn per `run isolated` call, not per `jaiph run`.
- The rsync / `cp -a` fallback chain that fires when fuse-overlayfs is unavailable is removed for `run isolated`. Per guarantee #4, missing fuse-overlayfs is a hard error, not a quiet copy.
- `JAIPH_DOCKER_ENABLED` and any other on/off knobs are removed. Per guarantee #5.

Other backends — Podman, Firecracker, gVisor, microVM CLIs like `sbx` — are not part of v1. They become possible later if and only if they deliver all five guarantees, and they are not authoring surface either way.

The following are **not** acceptable backends:

- `cp -r` / `mkdtempSync` / "temporary directory copy" — same UID, no PID namespace, no env denylist, host filesystem fully writable. Workspace-write convention only. (This is what the previous attempt shipped, which is why it's enumerated.)
- A bare `git worktree add` — gives a clean filesystem view of the workspace but does nothing about processes, env, network, or the host filesystem outside the worktree.

A note on git worktrees specifically: they are a tempting filesystem-and-git-state convention for candidate branches (clean diffs via `git diff main..HEAD`, branch namespace per candidate, no data duplication). They are intentionally **not** part of v1 — they require git in both host and container, they don't apply to non-git workspaces, and they add a per-call lifecycle (worktree create/remove on the host) that the overlay backend does not need. The overlay backend works on any workspace, git or not. If diff cleanliness becomes a real problem, the answer is to filter the diff in `workspace.export_patch`, not to add worktrees.

- "It works in CI because we trust our own code" — `isolated` exists precisely for code that is not trusted (LLM-generated patches, third-party scripts, candidate branches in fan-out). Honor-system isolation defeats the primitive.

### Allowed host-level configuration

The backend may be tuned through host-level environment variables (and optionally a CLI config file), never through `.jh` config:

- `JAIPH_ISOLATED_IMAGE` — the container image used for `run isolated`. Defaults to the official GHCR image. May be overridden for development.
- Optional: container network policy, per-call timeout. Both are tuning knobs; neither changes whether isolation happens.

Anything that toggles or weakens isolation is forbidden surface.

## Configuration simplification

The current `config` surface contains several keys that describe the current sandbox backend rather than the desired orchestration semantics. Those keys should be dropped from the language-level config.

The target design should remove sandbox-backend config such as:

- `runtime.docker_enabled`
- `runtime.docker_image`
- `runtime.docker_network`
- `runtime.docker_timeout`
- workspace mount configuration tied to Docker
- matching `JAIPH_DOCKER_*` environment variables

These are implementation details. They make `.jh` files less portable and force users to reason about container plumbing instead of workflow intent.

The reduced `config` surface should keep only things that are genuinely language-adjacent or execution-policy-adjacent, for example:

- agent backend / model selection
- run artifact location
- debug / observability settings
- recover retry limit / loop budget
- module metadata

Backend-specific sandbox tuning lives at the host level only. See [Allowed host-level configuration](#allowed-host-level-configuration) for the allowed knobs (image name, optional network/timeout). Anything that lets a `.jh` author or environment variable disable or weaken isolation is forbidden.

## Remove `rule` and `ensure`

Both `rule` and `ensure` are removed.

`rule` is a workflow plus execution policy. Once execution policy moves to the call site (`run readonly ...`), `rule` is no longer a distinct primitive — it is a `workflow` called with `readonly`.

`ensure` is sugar over default failure propagation. Today, `ensure X` aborts the workflow if `X` fails, and `ensure X catch(err) { ... }` runs the catch block on failure. `run` already propagates failures by default, so:

```jh
ensure check()                          # becomes
run check()

ensure check() catch(err) { ... }       # becomes
run check() catch(err) { ... }
```

Functionally identical after the swap. The only loss is the semantic hint "this is a precondition," which is documentation, not behavior. Removing `ensure` cuts a top-level keyword without losing any execution semantics.

The validation pattern that used `ensure run readonly check()` collapses to:

```jh
run readonly validate_task(task)
run readonly ci.check()
```

Migration of existing `.jh` files is mechanical: replace `ensure` with `run` (preserving any `catch` clause) and replace `rule` with a `workflow` invoked via `run readonly`.

## Language surface after simplification

The target language should aim for a smaller top-level set:

- strings
- scripts
- prompts
- config
- channels
- workflows
- `run`
- `recover`

`ensure` and `rule` are removed (see above). A separate lightweight `task` primitive is not introduced as part of this rewrite; see below.

Anything that can be expressed as execution policy on `run` should not become its own heavyweight concept.

## `workflow` stays; lightweight unit deferred

For this rewrite, `workflow` remains the only definable orchestration unit. A lightweight reusable primitive (provisionally `task`) is deliberately deferred.

Reasoning:

- The runtime and execution model are already changing significantly. Adding a second declarable unit during the same rewrite doubles the cognitive surface.
- A `task` introduced now and a `workflow → task` rename later would be two breaking changes for one outcome. Better to land the runtime work first, then decide whether `workflow` should be renamed in a single move at the end.
- Until then, helpers are written as additional `workflow` declarations. This is mildly verbose but unambiguous.

If the final cleanup pass concludes that a rename is worthwhile, it happens once, after the rest of the redesign has stabilized. Until that pass, this design assumes only `workflow`.

## `recover`

Jaiph should add a new primitive: `recover`.

Today, Jaiph has:

```jh
run sth() catch(err) {
  ...
}
```

That is ordinary try/catch behavior: one attempt, then recovery logic after failure.

The new primitive supports repair loops:

```jh
run sth() recover(err) {
  some actions
}
```

The contract is:

- attempt `sth()`.
- if it succeeds, continue.
- if it fails, bind the failure payload to `err`.
- execute the `recover` block.
- retry `sth()`.
- repeat until success or until the retry limit is reached.

This is not the same as `catch`. `catch` handles failure after a single attempt. `recover` actively tries to repair the system and re-run the protected step.

The default recover loop limit is small and explicit (`10`), with an override available through `config`.

`recover` composes with isolation per the rules in [Composition rules](#composition-rules): for an isolated branch, the recover block executes inside the branch's container, retries happen there, and the coordinator only ever sees the final outcome.

The goal is to make "repair, then retry" a first-class control-flow tool instead of forcing users to hand-roll retry loops in scripts or deeply nested workflow logic.

## Explicit breaking removals

The redesign removes any feature whose main effect is cognitive overhead. The removals are:

- `rule`
- `ensure`
- user-visible Docker mode
- sandbox-backend-specific `runtime.*` config
- `JAIPH_DOCKER_*` env surface (including `JAIPH_DOCKER_ENABLED` and the whole-program Docker spawn path in `cli/commands/run.ts`)
- multiple user-facing ways to execute the same `.jh` file with different isolation semantics
- any escape hatch that disables or weakens `run isolated` (no `--no-sandbox`, no `JAIPH_ISOLATION_DISABLED`, no fallback to a non-isolating backend)
- the implicit end-of-workflow async join as a *contract* (the behavior is preserved, but joining is now a property of handle reads, not a hidden cleanup step)

This is deliberate simplification, not a temporary transition state. Backward compatibility is explicitly not a goal; Jaiph is not yet in production use, so no migration period is owed to existing callers.

## Implementation pitfalls observed in the prior attempt

A previous pass at implementing this design shipped nine commits and missed five things in ways that are easy to repeat. Recording them here so the same misreadings do not survive a re-attempt.

1. **`run isolated` was implemented as `mkdtempSync` + `cpSync`.** A copy of the workspace in `/tmp` with the same UID, no PID namespace, no env denylist, and no read-only host mount provides workspace-write convention only. An adversarial or buggy branch can read `~/.ssh`, write the coordinator workspace, kill the parent, exfiltrate secrets, publish to npm — same blast radius as if it ran inline. See [What `isolated` guarantees](#what-isolated-guarantees) and [Backend choice](#backend-choice). The contract is OS-level isolation, not workspace scoping.
2. **`recover` for `run async [isolated] foo() recover(err) { ... }` was not implemented.** The composition is defined in [Recover inside isolated branches](#recover-inside-isolated-branches). The previous attempt's parser silently rejected the syntax with a generic "trailing content" error, and no later task picked it up. The composition must ship in the same task that adds `Handle<T>`.
3. **Nested-isolation check was shallow.** The validator only looked at the immediate target's body, so transitive nesting via an intermediate workflow (`run isolated A` where A → B → C and C contains `run isolated D`) passed validation. A static call-graph walk **and** a runtime guard (via a sentinel like `JAIPH_BRANCH_ID`) are both required.
4. **`JAIPH_DOCKER_*` env vars and the whole-program Docker spawn path were left in place.** The previous pass removed in-`.jh` `runtime.docker_*` keys but kept `JAIPH_DOCKER_ENABLED` and the `if (dockerConfig.enabled) spawnDockerProcess(...)` path in `cli/commands/run.ts`. The cleanup is only complete when those are gone too. There is no on/off switch for sandboxing — see [Explicit breaking removals](#explicit-breaking-removals).
5. **`workspace.export_patch` silently excludes `.jaiph/`** from the produced patch (necessary, since branches and coordinator both write there) **but the docs do not mention it.** Users will lose changes to `.jaiph/*` from a patch and not understand why. Document the exclusion in `docs/libraries.md` and in the `workspace.jh` source.

## Target principles

The target design should be judged against these principles:

1. Execution semantics are visible at the call site.
2. Isolation is a runtime capability, not a file-level mode.
3. The language surface stays small and orthogonal.
4. Strong orchestration patterns such as candidate generation and joining are easy to express.
5. Backend details do not leak into normal `.jh` authoring.
6. Features that are hard to explain simply should be removed.

## Non-goal

Backward compatibility is explicitly not a goal for this redesign.

If a current feature conflicts with a simpler and more coherent target model, the target model wins.
