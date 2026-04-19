---
title: "Spec: Handle, Isolation, and Recover Composition"
permalink: /spec-async-isolated
redirect_from:
  - /spec-async-isolated.md
---

# Spec: Handle, Isolation, and Recover Composition

This document is the formal specification for the `Handle<T>` value model, isolation composition rules, and `recover` semantics. It is referenced from [Target Design](target-design.md) §Async contract redesign and §Composition rules.

Every rule below has a named placeholder test. Implementation of those tests lands in the corresponding later tasks; this document is the contract they must satisfy.

## 1. `Handle<T>` value model

### 1.1 Creation

`run async expr` returns a `Handle<T>` immediately, where `T` is the return type of the called function. The runtime begins executing the target concurrently.

### 1.2 Passthrough vs read

A handle has two interaction modes:

- **Passthrough.** Assignment (`b = h`), storage in a list, passing as an argument unchanged, and returning unchanged from a function are passthrough operations. Passthrough does **not** force resolution. The handle propagates as an opaque token.
- **Read.** Any operation that requires the underlying value forces resolution: passing as an argument to `run`, string interpolation (`"${h}"`), comparison, conditional branching, arithmetic, indexing, or any other value-consuming expression. On read, the runtime blocks the current execution until the handle's branch completes, then substitutes the resolved value.

The first non-passthrough read forces resolution. Subsequent reads of the same handle return the cached resolved value without blocking.

### 1.3 Resolution outcome

A handle resolves to whatever the called function returned. If the function returned a string, the handle resolves to that string. If the function returned nothing, the handle resolves to the empty string (Jaiph's default return value). There is no wrapper type or metadata envelope; the resolved value is the plain return value.

### 1.4 Implicit join at workflow exit

When a workflow exits with handles still unresolved, the runtime implicitly joins (blocks on) every remaining unresolved handle before the workflow completes. This is not an error. It is equivalent to inserting a read of each unresolved handle at the end of the workflow.

There is no fire-and-forget mode. Every `run async` branch is guaranteed to complete before the enclosing workflow returns.

### 1.5 Error propagation

If the branch behind a handle fails (after exhausting any `recover` loop), the handle resolves to a failure. Reading a failed handle propagates the failure to the reader. If an unresolved failed handle is joined at workflow exit, the workflow itself fails.

## 2. Isolation contract

### 2.1 `isolated` is OS-level isolation

`isolated` is an **OS-level isolation contract**, not a workspace-write convention. When a workflow author writes `run isolated foo()`, the runtime guarantees all of the following for the duration of `foo`'s execution:

1. **Read-only host filesystem.** The host workspace is mounted read-only as the lower layer of a fuse-overlayfs overlay. Writes from inside the branch land in a writable upper layer that is discarded on teardown. The branch cannot modify any file outside its designated writable workspace (`/jaiph/workspace` overlay upper) and its run-artifacts directory (`/jaiph/run`).

2. **Separate PID namespace.** The branch executes in a separate PID namespace. `kill $PPID` from inside the branch cannot reach the coordinator process. The branch cannot inspect or signal host processes.

3. **Separate mount namespace.** The branch's filesystem view is constructed by the container runtime. The branch cannot mount or remount host paths.

4. **No host credential leakage.** Environment variables matching the following prefixes are **not** forwarded into the branch: `SSH_`, `GPG_`, `AWS_`, `GCP_`, `AZURE_`, `GOOGLE_`, `DOCKER_`, `KUBE`, `NPM_TOKEN`. This list is defined in `src/runtime/docker.ts` as `ENV_DENYLIST_PREFIXES`.

5. **No network namespace sharing** (future hardening). The v1 implementation uses Docker's default network mode. Later versions may restrict to `--network=none` or a scoped network per branch.

6. **No silent fallback.** If the host cannot provide a backend that satisfies the guarantees above, `run isolated` is a hard error at runtime with an actionable message. It does not degrade to `mkdtemp`/`cp`, a `git worktree`, or any non-isolating backend.

7. **No on/off switch.** There is no env var, CLI flag, or config key that disables isolation, makes it optional, or routes `run isolated` through a non-isolating backend. Absence of `isolated` means shared execution; presence of `isolated` means OS-level isolated execution. Always.

### 2.2 v1 backend: Docker + fuse-overlayfs

The v1 backend is fixed: **Docker + fuse-overlayfs, reusing the existing implementation in `src/runtime/docker.ts`**. The redesign re-wires that code for per-call `run isolated` invocation (instead of whole-program Docker mode) and tightens it (removing the on/off switch and silent fallback). It does not introduce a second backend.

What the existing code already provides and `run isolated` reuses:

- fuse-overlayfs mount with the host workspace as a read-only lower layer and an in-container writable upper layer, merged at `/jaiph/workspace`.
- `--cap-drop ALL` plus only `SYS_ADMIN` for fuse-overlayfs. (`no-new-privileges` is not set for the isolated path because `fusermount3` is a setuid binary that requires privilege escalation.)
- The credential env denylist enumerated in §2.1.
- A host-path mount denylist (Docker socket, `/proc`, `/sys`, `/dev`).
- A host-writable run-artifacts directory (`/jaiph/run`) mounted `:rw` outside the overlay, so exports survive container teardown.

What changes from the existing code:

- The whole-program "run the entire `.jh` file inside Docker" launch path is removed. Containers spawn per `run isolated` call.
- The rsync/`cp -a` fallback chain is removed. Missing fuse-overlayfs is a hard error per §2.1 guarantee 6.
- `JAIPH_DOCKER_ENABLED` and any other on/off knobs are removed per §2.1 guarantee 7.

### 2.3 Rejected backends

The following are not acceptable as isolation backends:

- **`mkdtempSync` + `cpSync` (temporary directory copy).** Same UID, no PID namespace, no env denylist, host filesystem fully writable. Workspace-write convention only.
- **`git worktree add`.** Gives a clean filesystem view of the workspace but provides no process, env, network, or host-filesystem isolation.

**Decision record — why not `git worktree`:** git worktrees require git in both host and container, do not apply to non-git workspaces, and add a per-call host-side lifecycle (create/remove worktree) that the overlay backend does not need. The overlay backend works on any workspace, git or not. If diff cleanliness becomes a problem, the answer is to filter the diff in `workspace.export_patch`, not to add worktrees.

Other backends (Podman, Firecracker, gVisor, microVM CLIs) are not part of v1. They become possible later if and only if they deliver all guarantees in §2.1.

### 2.4 Allowed host-level configuration

The backend may be tuned through host-level environment variables, never through `.jh` config:

- `JAIPH_ISOLATED_IMAGE` — the container image used for `run isolated`. Defaults to the official GHCR image.
- Optional: container network policy, per-call timeout. Both are tuning knobs; neither changes whether isolation happens.

Anything that toggles or weakens isolation is forbidden surface.

## 3. Nested isolation

### 3.1 Rule

`run isolated` inside an already-isolated execution context is a **compile-time error**.

This includes the **transitive case**: if `run isolated A()` is written, and `A` calls `B`, and `B` calls `run isolated C()`, the compiler must reject the program. The check walks the static call graph starting from the target of every `run isolated` call and rejects any reachable `run isolated` statement.

### 3.2 Rationale

Isolation does not nest. One container per top-level isolated call. Re-isolating inside an isolated branch is meaningless (the inner call is already isolated) and almost always a bug (it would require Docker-in-Docker or equivalent, which violates the least-privilege stance).

### 3.3 Runtime guard

In addition to the compile-time check, the runtime sets a sentinel environment variable (`JAIPH_BRANCH_ID`) inside every isolated container. If `run isolated` is attempted and `JAIPH_BRANCH_ID` is already set, the runtime produces a hard error. This guards against dynamic dispatch paths that the static analysis cannot reach.

### 3.4 Calls inside an isolated body

Calls inside an isolated body (`run foo()`, `run bar()` — without the `isolated` modifier) execute in the same sandboxed container. There is no nested isolation, no new container, and no additional overhead. The isolation boundary is the outermost `run isolated` call.

## 4. Recover composition

### 4.1 `recover` for isolated async branches

For `b = run async isolated foo() recover(err) { ... }`:

1. The branch launches in an isolated container.
2. The branch executes `foo()` inside that container.
3. On failure, `err` is bound to the failure payload.
4. The `recover` block executes **inside the same isolated container**, in the same workspace state.
5. After the recover block completes, `foo()` retries inside the same container.
6. The loop continues until `foo()` succeeds or the retry limit (default 10, configurable via `config`) is exhausted.
7. The handle resolves to either the success result or the final failure. The coordinator never observes intermediate failures.

**Key invariant:** the recover block for an isolated branch runs inside the branch's sandboxed context. It can mutate the branch workspace. It cannot mutate the coordinator workspace. Recovery never leaks back across the isolation boundary.

### 4.2 `recover` for non-isolated runs

For `run foo() recover(err) { ... }` (no `isolated`):

1. The runtime attempts `foo()`.
2. On failure, `err` is bound to the failure payload.
3. The `recover` block executes in the current workspace.
4. `foo()` retries.
5. Loop until success or retry limit exhausted.

This is the baseline `recover` behavior, independent of isolation.

### 4.3 `recover` for async non-isolated runs

For `b = run async foo() recover(err) { ... }`:

1. The branch starts concurrently in the shared workspace.
2. On failure, the `recover` block runs in the shared workspace (same as §4.2).
3. Retries proceed in the shared workspace.
4. The handle resolves to the final outcome.

### 4.4 Retry limit

The default retry limit is 10. It is configurable via the `config` block (key: `recover_limit` or equivalent). When the limit is exhausted, the run fails with the last error.

## 5. Removed constructs

### 5.1 `ensure` is removed

`ensure` is sugar over `run` with default failure propagation. `run` already propagates failures by default. Migration is mechanical: replace `ensure X` with `run X`, preserving any `catch` clause.

### 5.2 `rule` is removed

`rule` is a workflow with baked-in execution policy. Once execution policy moves to the call site (`run readonly ...`), `rule` collapses to a `workflow` called with the `readonly` modifier.

## 6. Planned test matrix

Every rule in this spec has a named placeholder test below. Tests are grouped by the task that will implement them. Test names use the convention `<layer>::<description>`.

### 6.1 Handle value model tests

| Test name | Rule | Implementing task |
|---|---|---|
| `handle::async_run_returns_handle` | §1.1 — `run async` returns a Handle | Handle<T> runtime |
| `handle::passthrough_assignment_no_resolve` | §1.2 — assignment does not force resolution | Handle<T> runtime |
| `handle::passthrough_return_no_resolve` | §1.2 — returning handle from function does not force resolution | Handle<T> runtime |
| `handle::passthrough_list_storage_no_resolve` | §1.2 — storing in list does not force resolution | Handle<T> runtime |
| `handle::read_via_run_arg_forces_resolve` | §1.2 — passing as `run` arg forces resolution | Handle<T> runtime |
| `handle::read_via_interpolation_forces_resolve` | §1.2 — string interpolation forces resolution | Handle<T> runtime |
| `handle::read_via_comparison_forces_resolve` | §1.2 — comparison forces resolution | Handle<T> runtime |
| `handle::read_via_conditional_forces_resolve` | §1.2 — conditional branch forces resolution | Handle<T> runtime |
| `handle::resolve_returns_function_return_value` | §1.3 — resolved value is the plain return value | Handle<T> runtime |
| `handle::resolve_empty_return_gives_empty_string` | §1.3 — no return → empty string | Handle<T> runtime |
| `handle::implicit_join_at_workflow_exit` | §1.4 — unresolved handles joined at exit | Handle<T> runtime |
| `handle::implicit_join_not_an_error` | §1.4 — implicit join is not a failure | Handle<T> runtime |
| `handle::no_fire_and_forget` | §1.4 — workflow waits for all branches | Handle<T> runtime |
| `handle::failed_branch_propagates_on_read` | §1.5 — reading a failed handle propagates failure | Handle<T> runtime |
| `handle::failed_unresolved_handle_fails_workflow` | §1.5 — failed handle at implicit join fails workflow | Handle<T> runtime |
| `handle::multiple_handles_candidate_join_pattern` | §1.2/1.3 — fan-out + join pattern with 3 handles | Handle<T> runtime |

### 6.2 Isolation containment tests

| Test name | Rule | Implementing task |
|---|---|---|
| `isolation::host_filesystem_readonly` | §2.1.1 — writes to host paths fail or land in overlay upper | Isolation runtime |
| `isolation::overlay_upper_writable` | §2.1.1 — writes to workspace land in writable upper layer | Isolation runtime |
| `isolation::overlay_discarded_on_teardown` | §2.1.1 — upper layer changes do not persist to host | Isolation runtime |
| `isolation::separate_pid_namespace` | §2.1.2 — `kill $PPID` cannot reach coordinator | Isolation runtime |
| `isolation::cannot_signal_host_processes` | §2.1.2 — branch cannot inspect or signal host PIDs | Isolation runtime |
| `isolation::credential_env_not_forwarded` | §2.1.4 — SSH_, AWS_, etc. env vars not present in branch | Isolation runtime |
| `isolation::no_silent_fallback` | §2.1.6 — missing Docker → hard error, not degraded mode | Isolation runtime |
| `isolation::no_disable_switch` | §2.1.7 — no env/config can turn off isolation | Isolation runtime |
| `isolation::run_artifacts_survive_teardown` | §2.2 — `/jaiph/run` is host-writable and persists | Isolation runtime |
| `isolation::denied_host_paths_not_mounted` | §2.2 — Docker socket, /proc, /sys, /dev not accessible | Isolation runtime |
| `isolation::cap_drop_all_enforced` | §2.2 — container runs with `--cap-drop ALL` | Isolation runtime |
| `isolation::no_new_privileges` | §2.2 — `--security-opt no-new-privileges` is set | Isolation runtime |
| `isolation::uses_docker_backend` | §2.2 — v1 uses Docker + fuse-overlayfs, not any other backend | Isolation runtime |

### 6.3 Nested isolation tests

| Test name | Rule | Implementing task |
|---|---|---|
| `nested_isolation::direct_nested_isolated_compile_error` | §3.1 — `run isolated` inside isolated body is compile error | Nested isolation validator |
| `nested_isolation::transitive_nested_isolated_compile_error` | §3.1 — A→B→`run isolated C` rejected when A is `run isolated` | Nested isolation validator |
| `nested_isolation::deep_transitive_chain_compile_error` | §3.1 — A→B→C→D→`run isolated E` rejected | Nested isolation validator |
| `nested_isolation::runtime_guard_rejects_double_isolation` | §3.3 — `JAIPH_BRANCH_ID` set → `run isolated` hard error | Nested isolation runtime |
| `nested_isolation::calls_inside_isolated_body_share_container` | §3.4 — `run foo()` inside isolated body runs in same container | Nested isolation runtime |
| `nested_isolation::no_new_container_for_inner_calls` | §3.4 — inner calls do not spawn additional containers | Nested isolation runtime |

### 6.4 Recover composition tests

| Test name | Rule | Implementing task |
|---|---|---|
| `recover::isolated_branch_recover_runs_inside_container` | §4.1.4 — recover block runs in branch sandbox | Recover runtime |
| `recover::isolated_branch_recover_retries_inside_container` | §4.1.5 — retry happens inside same container | Recover runtime |
| `recover::isolated_branch_coordinator_sees_final_only` | §4.1.7 — coordinator never observes intermediate failures | Recover runtime |
| `recover::isolated_branch_recover_can_mutate_branch_workspace` | §4.1 — recover block can write to branch workspace | Recover runtime |
| `recover::isolated_branch_recover_cannot_mutate_coordinator` | §4.1 — recover block cannot write coordinator workspace | Recover runtime |
| `recover::non_isolated_recover_runs_in_current_workspace` | §4.2 — recover block runs in caller's workspace | Recover runtime |
| `recover::non_isolated_recover_retries_in_current_workspace` | §4.2.4 — retry in current workspace | Recover runtime |
| `recover::async_non_isolated_recover_in_shared_workspace` | §4.3 — async recover uses shared workspace | Recover runtime |
| `recover::retry_limit_default_10` | §4.4 — default limit is 10 | Recover runtime |
| `recover::retry_limit_configurable` | §4.4 — config overrides default limit | Recover runtime |
| `recover::exhausted_retries_fail_with_last_error` | §4.4 — final error propagated when limit hit | Recover runtime |
| `recover::success_after_recover_resolves_normally` | §4.1/4.2 — successful retry returns success value | Recover runtime |

### 6.5 Removed construct tests

| Test name | Rule | Implementing task |
|---|---|---|
| `removed::ensure_keyword_compile_error` | §5.1 — `ensure` is no longer valid syntax | Syntax cleanup |
| `removed::rule_keyword_compile_error` | §5.2 — `rule` is no longer valid syntax | Syntax cleanup |
