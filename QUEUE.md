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

## Runtime — kill isolated containers on parent signal #dev-ready

**Goal**
When the user Ctrl-C's a `jaiph run` that has live `run isolated` containers, those containers must stop within seconds — not keep running until their in-container workload completes naturally.

**Context (read before starting)**

Verified bug: a workflow with three `run async isolated` branches each running `sleep 30` was SIGINT'd 5s in. `jaiph` exited cleanly with `Process terminated by signal SIGINT`. Three Docker containers kept running for the full remaining ~25s of in-container sleep, only exiting when the in-container workload finished naturally and `--rm` cleaned up the stopped container. With a long-running workload (e.g. an agent prompt taking 5+ minutes), the user's Ctrl-C would leave containers consuming CPU, network, and possibly external API budget until the workload completed.

The CLI's signal handler in `src/cli/run/lifecycle.ts` correctly sends SIGINT to the worker process group via `kill(-pid, "SIGINT")`. That reaches each spawned `docker run` CLI client. Killing the docker CLI client does **not** stop the daemon-managed container — that is standard docker behavior. The container has to be stopped explicitly via `docker stop` (or `docker kill`) by ID/name/label.

The runtime currently does not capture container identifiers (no `--name`, no `--cidfile`, no `--label`) — see `buildIsolatedDockerArgs` in `src/runtime/docker.ts`. So even if a signal handler were added, there is nothing to target.

**Scope**

* When spawning each isolated container in `spawnIsolatedProcess`, attach a stable identifier the runtime can later target. Either:
  * pass `--name jaiph-isolated-<runId>-<branchId>` and stop by name, or
  * pass `--label jaiph-run-pid=<pid>` (or both `--label jaiph-run-pid` and `--label jaiph-branch-id`) and stop via `docker ps -q --filter label=...`, or
  * pass `--cidfile <runDir>/<branch>.cid` and stop by reading the cidfile.
  Whichever is chosen, the identifier must be unique per branch and discoverable from the host without scanning every container on the system.
* Install signal handlers (`SIGINT`, `SIGTERM`) inside the runtime worker that, before exiting, run `docker stop --time=5 <id>` (or `docker kill` after the grace period) for every live isolated container the worker has spawned. The 5s grace lets in-container processes flush logs and run cleanup.
* Handlers must be idempotent and survive partial failures: a `docker stop` failing for one container must not prevent the others from being stopped.
* The cleanup path must also fire on uncaught exceptions / abnormal exits in the worker, not only on user signals.

**Non-goals**

* No change to the container's contents or to `--rm` semantics. `--rm` continues to clean up the stopped container; this task adds the missing "stop" step.
* No change to host-side process-group signal propagation in `src/cli/run/lifecycle.ts` — that part works.
* No new sandboxing primitive.

**Acceptance criteria**

* An e2e test launches a workflow with `run isolated` running an in-container `sleep 60`, sends `SIGINT` to `jaiph` after 3s, and asserts that `docker ps --filter label=jaiph-run-pid=<pid>` (or whichever identifier scheme is used) returns empty within 10s of the signal.
* A second e2e variant uses `run async isolated` with three concurrent branches doing `sleep 60`, SIGINT after 3s, asserts all three containers stop within 10s.
* A third e2e variant kills the runtime worker with `SIGKILL` (so the in-process handlers cannot run) and documents the behavior — either by adding an external sweep at the CLI level (preferred) or by accepting that SIGKILL leaks containers and noting it explicitly in `docs/target-design.md`.

***

## Runtime — propagate plain-string return values from isolated branches #dev-ready

**Goal**
A `run isolated workflow_name(...)` whose body returns a plain string must surface that string to the caller, identical to a non-isolated `run`. Today the value is silently dropped.

**Context (read before starting)**

Verified bug, reproduced with `examples/isolated_mix.jh`:

```
workflow branch(label, secs) {
  return run branch_work(label, secs)   # branch_work prints the path on stdout
}

workflow default() {
  const a = run async isolated branch("A", "6")
  log "Branch A returned: ${a}"
}
```

Branches ran to completion (visible in the tree, exit 0, 6s elapsed). The handle resolved without error. But `${a}` interpolated as the empty string:

```
ℹ Branch A returned: 
ℹ Branch B returned: 
ℹ Branch C returned: 
```

`engineer.jh` works only because it uses `workspace.export_patch(name)` (a workflow that goes through a known protocol — see `.jaiph/libs/jaiphlang/workspace.jh`). Any branch that returns a plain `script` stdout, a literal string, or any other value not produced by `workspace.export_*` loses its return value at the isolated boundary.

The contract from `docs/target-design.md` ("Branch outputs") says branches return plain values that handles resolve to. There is no caveat that this only works for `workspace.export_*` calls. Today's behavior contradicts the contract.

**Scope**

* Whatever mechanism propagates `workspace.export_patch`'s return value across the container boundary must apply uniformly to any value returned from a workflow run via `run isolated` (or `run async isolated`). The standard library should have no privileged path.
* Likely root cause is in `src/runtime/kernel/node-workflow-runtime.ts` `executeIsolatedRunRef` — the host extracts the branch's return value from the container's `run_summary.jsonl` (or similar) only for specific shapes. Make the extraction generic: read the workflow's final `STEP_END` `out_content` (or whichever field carries the workflow return value) and use it as the handle's resolved value.
* Plain `script` returns (stdout) must round-trip: a workflow `return run some_script(...)` inside a branch must yield `some_script`'s stdout to the host caller.

**Non-goals**

* No change to `workspace.export_patch` or `workspace.export` semantics — they continue to work as today.
* No new return-value protocol or wire format.

**Acceptance criteria**

* An e2e test runs `run isolated b()` where `b()` returns a literal string `"hello"`. The host caller's `${a}` interpolates as `"hello"` (no quotes, no JSON wrapping, exact string equality).
* An e2e test runs `run async isolated b("X")` where `b` returns `run some_script("X")` and `some_script` prints `"path-X"` on stdout. The host caller's `${a}` interpolates as `"path-X"`.
* `examples/isolated_mix.jh` is added (or updated) so its three `Branch X returned:` log lines render with the actual paths, not empty. Asserted by an e2e test.
* The fix is generic — `workspace.export_*` continues to work without special-casing in the runtime.

***

## Runtime — surface live progress events from inside isolated branches #dev-ready

**Goal**
Long-running steps inside a `run async isolated` branch (e.g. `prompt claude` taking minutes) must render as live updates under that branch's node in the host progress tree, the same way they do for non-isolated steps.

**Context (read before starting)**

`run async isolated` works correctly today at the value level: containers spawn per call, fuse-overlayfs isolation holds, handles propagate, branches export named patches, the joiner consumes them, and `select_best_candidate` runs to completion (verified end-to-end after the image-provisioning bug was fixed in `src/runtime/docker.ts`'s `buildImageFromDockerfile`).

What does **not** work is the live progress feedback loop:

* The runtime forwards `__JAIPH_EVENT__` lines from the container's stderr to the host stderr (see `executeIsolatedRunRef` in `src/runtime/kernel/node-workflow-runtime.ts`).
* The host progress renderer does **not** surface those events as live updates under the parent `run async isolated` step. Branches appear frozen until they complete.
* The host's `run_summary.jsonl` contains zero `STEP_START` / `STEP_END` events for the branches' interior steps. Branch failures don't surface as `STEP_END status:1` either — a non-zero branch exit is only discovered when the joiner stumbles on its handle, several layers removed from where it actually happened.

**Scope**

* The host progress renderer must treat container-originated `__JAIPH_EVENT__` lines (forwarded via stderr from `executeIsolatedRunRef`) as first-class progress events, attached to the parent `run async isolated` node and rendered live.
* Branch-interior `STEP_START` / `STEP_END` events from inside the container must appear in the host's `run_summary.jsonl` as children of the branch step, with correct `parent_id` linkage.
* Non-zero branch exits must surface on the host as a `STEP_END status:1` event for the branch step, with the failed interior step's `err_content` propagated up — not deferred until handle consumption.
* Bubble up enough context that "branch 2 of 3 failed at step X with error Y" is visible in the live frame, not only in the post-mortem run files.

**Non-goals**

* No change to the isolation contracts (`docs/target-design.md` → "What `isolated` guarantees").
* No change to handle resolution or join semantics — those work at the value level.
* The `jaiph-test-block-` tempdir prefix observed in `apply_patch` output is tracked separately; do not chase it here.

**Acceptance criteria**

* An e2e test runs `run async isolated branch()` where `branch` performs a step that emits ≥3 `__JAIPH_EVENT__` progress events spaced ≥500ms apart, and asserts that those events appear in the host progress stream **as they happen** (not batched at branch completion). The test uses a real PTY (see the next task in this queue) so it exercises the live-frame renderer.
* An e2e test runs `run async isolated branch()` where `branch` exits non-zero from an interior step, and asserts that the host's `run_summary.jsonl` contains a `STEP_END status:1` event for the branch step (not only for the eventual joiner that touched the handle), with the interior failure's `err_content` propagated.
* The host's `run_summary.jsonl` for any `run async isolated` workflow contains the branch's interior `STEP_START` / `STEP_END` events with correct `parent_id` chaining.

***

## Runtime — PTY-based TTY test for run async isolated #dev-ready

**Goal**
The live-progress regression in `run async isolated` was invisible to CI because no test exercises live progress through a real PTY for the async-isolated path. Close that gap.

**Context (read before starting)**

`e2e/tests/81_tty_progress_tree.sh` already uses Python's `pty.openpty()` to drive `jaiph run` under a real TTY and asserts on the rendered progress frames. It covers non-async, non-isolated workflows. There is no equivalent for `run async` or `run async isolated`. The host progress renderer takes a different path for those (handles, deferred resolution, container-forwarded events), and that path was broken.

**Scope**

* Add an e2e test (sibling of `e2e/tests/81_tty_progress_tree.sh`) that:
  * spawns `jaiph run` under a real PTY,
  * exercises a workflow that uses `run async isolated branch()` with at least two concurrent branches,
  * each branch emits multiple progress events over time (use a deterministic step like a sleep loop with `print` calls — do not depend on `prompt claude`),
  * captures the PTY output and asserts:
    1. no Docker buildkit output appears in the frame stream,
    2. each branch's progress events appear under that branch's node in the tree as they happen,
    3. the final frame shows both branches as completed with their explicit return values,
    4. no ANSI corruption (orphaned escape sequences, stray cursor moves outside the rendered region).
* Add a second, smaller PTY test for `run async` (non-isolated) to catch handle-renderer regressions independently of Docker.
* The tests must fail today against the live-progress bug described in the previous task. Verify this by running them on `HEAD` before the previous task is fixed (or against a deliberately reverted build).

**Non-goals**

* Do not test `prompt claude` or any non-deterministic step. The branches must emit synthetic, time-spaced events.
* Do not assert on exact frame timing; assert on order and presence within a generous timeout.

**Acceptance criteria**

* New tests live next to `e2e/tests/81_tty_progress_tree.sh` and follow the same shell-driving-Python-PTY pattern.
* Both tests pass on a green build and fail when the live-progress regression in the previous task returns.
* Tests run as part of the standard e2e suite (no separate invocation).

***

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
