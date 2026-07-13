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

## Distro: native Windows smoke job in CI #dev-ready

CI's only Windows coverage runs the e2e suite inside WSL (`e2e-wsl` in `.github/workflows/ci.yml`), which exercises the Linux binary. Developing Jaiph on Windows is out of scope — this job proves *running* Jaiph natively works.

Add a `windows-native-smoke` job on `windows-latest`:

* Build the standalone Windows binary from the checkout (`bun build --compile --target=bun-windows-x64`).
* With Git for Windows' `sh.exe` available (preinstalled on the runner), run a sample workflow host-only (`JAIPH_UNSAFE=true`) that covers: an inline shell line, a `script` step with a non-bash lang tag (e.g. ` ```node `), string interpolation, and `log` output.
* Assert the process tree is cleaned up after a mid-run cancellation (spawn `jaiph run`, terminate it, assert no orphaned child processes remain).
* No agent-backend credentials in this job: `prompt`-step coverage is limited to the credential pre-flight failing with the documented error, not a hang.
* Keep `e2e-wsl` as-is; do not gate its removal on this task.

Acceptance:

* The smoke job is required for merge (listed in the CI gate alongside `test`/`e2e`/`e2e-wsl`).
* Workflow output assertions run against actual `jaiph.exe` stdout (exit code + expected `log` lines).
* The cancellation assertion fails if any child of the workflow leader survives termination.
* The job completes with no WSL usage (fails if `wsl` is invoked).

***
