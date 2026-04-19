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

***

## Language/Runtime — add `recover` loop semantics for non-isolated `run` #dev-ready

**Goal**
Add `recover` as a first-class repair-and-retry primitive distinct from `catch`. Ship for non-isolated, non-async `run` first. Async composition lands in the next task, not here.

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

***

## Runtime — spec and implement `Handle<T>` for `run async`, including `recover` composition #dev-ready

**Goal**
Replace the current implicit end-of-workflow join with a value-based handle model. `run async foo()` returns a `Handle<T>` immediately. The handle resolves on first non-passthrough read. Workflow exit implicitly joins remaining unresolved handles. Ship `recover` composition for `run async` in the same task.

This task ships **both the written spec and the runtime implementation in one go.** The previous attempt split them across two tasks and the spec drifted from the implementation. Keep them together so the contract and the code land in the same review.

**Scope**

* Write the spec section in `docs/spec-async-handles.md` (a new file) covering:
  - `Handle<T>` value model: a handle resolves to whatever the called function returned. First non-passthrough read forces resolution. Passthrough (assignment, storage, passing through arguments and returns unchanged) does not.
  - Workflow exit implicitly joins any remaining unresolved handles; this is not an error.
  - No fire-and-forget mode.
  - `recover` composition: `b1 = run async foo() recover(err) { ... }` — handle resolves to either the eventual success value (after the retry loop runs) or the final failure. Same retry-limit semantics as the non-async `recover` task.
* Replace the implicit end-of-workflow join in `src/runtime/kernel/node-workflow-runtime.ts` with the value-based handle model.
* `run async ...` returns a `Handle<T>` value. `T` is the same return type the function would have under a non-async `run`.
* Reads that force resolution: passing as an argument to `run`, string interpolation, comparison, conditional branching, any other access to the underlying value.
* Passthrough (assignment, storing in a list, passing through `workflow` arguments and returns unchanged) does not force resolution.
* Workflow exit implicitly joins unresolved handles. This preserves today's end-of-workflow behavior at the boundary.
* Parser must accept `recover(err) { ... }` after `run async ref(args)`. The previous attempt had the parser silently reject this with a "trailing content" error — that is the failure mode to fix.
* Preserve async progress/event visibility unless the contract forces an intentional change.
* Update docs that still describe the old statement-based async model.

**Required tests**

* Parser / formatter / validation coverage for `run async ref(args) recover(err) { ... }`.
* Runtime tests for handle creation, transparent resolution at first read, and resolution forced by passing a handle into another `run`.
* Runtime test for the multi-handle join shape: multiple async handles passed into another call all resolve before the callee runs.
* Runtime test that workflow exit joins unresolved handles without raising an error.
* Runtime test that handles can be stored in a list and resolved when read.
* Runtime test for `run async foo() recover(err) { ... }`: handle resolves to the success value after at least one repair loop.
* Runtime test that the retry-limit semantics are shared with the non-async `recover` task.

**Acceptance criteria**

* `run async ...` returns a first-class handle value.
* Handle reads force resolution per the spec.
* Workflow exit implicitly joins remaining handles (no error).
* `recover` works on `run async ref()`. The parser accepts the form; the runtime implements the spec contract.
* Spec and implementation ship in the same change set; the spec is internally consistent and self-contained.
* The docs-site Jaiph syntax highlighter (`docs/assets/js/main.js`) recognizes `async` as a keyword (modifier on `run`) and continues to highlight `recover` correctly when it appears as `recover(err) { ... }` after `run async ref(args)`. A docs code block with `b1 = run async foo() recover(err) { ... }` renders with `run`, `async`, and `recover` all colored.

***

## Artifacts — runtime mount + `artifacts.jh` lib for publishing files out of the sandbox #dev-ready

**Goal**
Give workflows a clean, versatile way to publish files from inside the whole-program Docker sandbox to a host-readable location. Split the work across two layers:

* **Runtime layer** (in `src/runtime/`): expose a writable artifacts directory inside the sandbox at a stable path, mapped to `.jaiph/runs/<run_id>/artifacts/` on the host. No new language primitive; the runtime's only job is to mount and to surface the path via env var.
* **Library layer** (in `.jaiph/libs/jaiphlang/`): ship a new `artifacts.jh` lib (mirroring the existing `queue.jh` / `queue.py` pair) with `export workflow` entries for the common operations. Userspace imports the lib explicitly:

  ```jh
  import "jaiphlang/artifacts.jh" as artifacts

  workflow default() {
    run artifacts.save("./build/output.bin", "build-output.bin")
    run artifacts.save_patch("snapshot.patch")
  }
  ```

This keeps the runtime minimal (just a mount), makes the surface library-shaped (so it's discoverable and replaceable), and matches the established `queue.jh` pattern.

**Context (read before starting)**

* Today's whole-program Docker sandbox in `src/runtime/docker.ts` already mounts the run directory writable at `/jaiph/run`. Artifacts will live in a subdirectory of that mount; no new mount is needed.
* The existing lib pattern is `.jaiph/libs/jaiphlang/queue.jh` paired with `.jaiph/libs/jaiphlang/queue.py` (a small Python helper invoked via `import script ... as queue`). Follow that pattern.
* The `isolated` keyword is not part of this codebase. This task is about the whole-program Docker sandbox only; no per-call isolation primitive exists or is to be introduced.

**Scope**

**Runtime layer:**

* Ensure `.jaiph/runs/<run_id>/artifacts/` exists on the host before the sandbox starts (`mkdirSync` with `recursive: true`).
* The existing `/jaiph/run` mount in the container already exposes the artifacts subdirectory implicitly. Verify it does, and that writes inside the container land at `.jaiph/runs/<run_id>/artifacts/` on the host.
* Surface the in-container artifacts path to userspace via an env var. Suggested name: `JAIPH_ARTIFACTS_DIR` (defaulting to `/jaiph/run/artifacts` in the container, `<host_run_dir>/artifacts` on the host when running without the sandbox). The library reads this env var rather than hardcoding the path.
* When running on the host (no sandbox), `JAIPH_ARTIFACTS_DIR` points at the host artifacts directory directly so the same lib works.

**Library layer:**

* Add `.jaiph/libs/jaiphlang/artifacts.jh` and `.jaiph/libs/jaiphlang/artifacts.py` (or `.sh` if it stays a one-liner). Mirror the `queue.jh` / `queue.py` shape exactly — no novel patterns.
* Provide these `export workflow` entries:
  - `save(local_path, name)` — copies the file at `local_path` into `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the host-resolved absolute path as a string.
  - `save_patch(name)` — runs `git diff` (working tree vs HEAD) inside the sandbox workspace, writes it to `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the host-resolved absolute path.
  - `apply_patch(path)` — applies a patch file to the current workspace via `git apply`. Useful for replaying artifacts across runs.
* The lib must work both inside the sandbox and on the host (when the user runs `jaiph` without the Docker sandbox). The only difference is what `JAIPH_ARTIFACTS_DIR` resolves to.
* Document that `save_patch` excludes `.jaiph/` from the produced patch (the runtime writes its own state under `.jaiph/`; including it in a patch would clobber state on apply). The exclusion lives in the lib's helper script, not in the runtime, and is documented inline next to the implementation.

**Required tests**

* **Runtime tests**:
  - `JAIPH_ARTIFACTS_DIR` is set inside the sandbox and points at a writable directory.
  - `JAIPH_ARTIFACTS_DIR` is set when running on the host (no sandbox) and points at `.jaiph/runs/<run_id>/artifacts/`.
  - The artifacts directory exists before the sandbox starts (no race where the lib tries to write before the dir exists).
* **Library tests**:
  - `artifacts.save(local_path, name)`: file is created at the host path; return value matches that path; file content equals the source.
  - `artifacts.save_patch(name)`: produces a non-empty patch when the workspace has uncommitted changes; produces an empty (or absent) patch when the workspace is clean; the patch does not reference `.jaiph/` even when `.jaiph/` files have changed.
  - `artifacts.apply_patch(path)`: applies a previously-saved patch cleanly; fails with a clear error when the patch does not apply.
* **End-to-end**:
  - One `.jh` example workflow that imports `jaiphlang/artifacts.jh`, calls `artifacts.save` and `artifacts.save_patch`, runs under the sandbox, and the test asserts both files appear on the host at the expected paths.

**Acceptance criteria**

* `.jaiph/runs/<run_id>/artifacts/` exists, is writable from inside the sandbox, and survives sandbox teardown (it's on the host filesystem via the existing mount).
* `JAIPH_ARTIFACTS_DIR` is exposed in both sandbox and host execution; the lib reads it rather than hardcoding paths.
* `.jaiph/libs/jaiphlang/artifacts.jh` ships with `save`, `save_patch`, `apply_patch` as `export workflow` entries, mirroring the `queue.jh` lib shape.
* The lib works identically inside the sandbox and on the host.
* `save_patch`'s `.jaiph/` exclusion is documented inline in the helper script.
* No new runtime language primitive is introduced. The user-facing surface is `import` + workflow calls.
* The docs-site documentation is updated to describe the artifacts lib alongside the queue lib (`docs/libraries.md` or equivalent).

***

## Runtime — PTY-based TTY test for `run async` #dev-ready

**Goal**
Live progress for `run async` (with handles, deferred resolution, multi-branch fan-out without isolation) takes a different render path than synchronous steps. Close the regression-coverage gap by exercising that path through a real PTY.

**Context (read before starting)**

`e2e/tests/81_tty_progress_tree.sh` already uses Python's `pty.openpty()` to drive `jaiph run` under a real TTY and asserts on the rendered progress frames. It covers non-async workflows. There is no equivalent for `run async`. The host progress renderer takes a different path for async (handles, deferred resolution, multiple in-flight calls competing for the live frame), and that path has been broken before without any test catching it.

**Scope**

* Add an e2e test (sibling of `e2e/tests/81_tty_progress_tree.sh`) that:
  * spawns `jaiph run` under a real PTY,
  * exercises a workflow that uses `run async branch()` with at least two concurrent async calls,
  * each branch emits multiple progress events over time (use a deterministic step like a sleep loop with `print` calls — do not depend on `prompt claude` or any other non-deterministic step),
  * captures the PTY output and asserts:
    1. each branch's progress events appear under that branch's node in the tree as they happen,
    2. the final frame shows both branches as completed with their resolved return values,
    3. no ANSI corruption (orphaned escape sequences, stray cursor moves outside the rendered region).
* The test must fail today against any regression that batches async progress events at branch completion, drops them, or scrambles the frame.

**Non-goals**

* Do not test `prompt claude` or any non-deterministic step. Branches must emit synthetic, time-spaced events.
* Do not assert on exact frame timing; assert on order and presence within a generous timeout.
* No `isolated` variant — that keyword is not part of this codebase.

**Acceptance criteria**

* New test lives next to `e2e/tests/81_tty_progress_tree.sh` and follows the same shell-driving-Python-PTY pattern.
* The test passes on a green build and fails when the live-progress path for `run async` regresses.
* Test runs as part of the standard e2e suite (no separate invocation).

***
