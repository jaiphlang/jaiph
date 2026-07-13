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

## Distro: main-page install tabs — Windows variant with platform auto-detect #dev-ready

The main page (`docs/index.html`) hero has three install tabs (run sample / init project / just install), all showing bash `curl … | bash` one-liners. Tab switching in `docs/assets/js/main.js` is click-only; there is no platform detection. Windows visitors currently see commands that cannot run natively.

Given a published PowerShell installer at `https://jaiph.org/install.ps1` (`irm https://jaiph.org/install.ps1 | iex`):

* Add a Windows variant to the install section: at minimum the "Just install" panel must offer the PowerShell one-liner alongside the curl one (separate tab, sub-toggle, or swapped command — implementer's choice, but the PowerShell command must be copy-able via the existing copy button).
* Auto-detect the visitor's platform on load (`navigator.userAgentData?.platform` with `navigator.platform` fallback) and default to the Windows variant for Windows visitors; macOS/Linux visitors see exactly today's default. Manual switching always remains possible; no layout shift for non-Windows users.
* Tabs whose commands have no PowerShell equivalent (run sample / init project) must not show a bash-only command as the Windows default — show the install one-liner plus a short "then run:" `jaiph` command instead, or an equivalent honest fallback.
* Keep the static-render constraint: the page must remain correct with JS disabled (bash commands shown, Windows variant reachable via tab markup).

Acceptance:

* Playwright docs tests (same suite as the "Try it out" test) assert: with a Windows platform emulated, the page defaults to the PowerShell command; with macOS/Linux emulated, the default is unchanged from today; manual tab switching works in both.
* The copy button on the Windows variant copies the exact `irm … | iex` line (asserted via clipboard stub).
* With JS disabled, all bash commands render and no panel is blank.
* Docs parity check (`.jaiph/docs_parity.jh`) passes with the new content.

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
