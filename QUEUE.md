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

## Fix: Ctrl+C on Docker `jaiph run` must stop the container #dev-ready

**Bug (reported):** Interrupting a long Docker-backed `jaiph run` (Ctrl+C / SIGINT on the host CLI) exits the terminal session, but the **`docker run` container keeps running** — `docker ps` still lists it minutes later. The orphaned container continues executing workflow/agent work (e.g. Claude running `npm test`) against the sandbox workspace with no attached host CLI.

**Current coverage gap:** `e2e/tests/74b_docker_signal_cleanup.sh` sends SIGINT to a background `jaiph run` and asserts **no `.sandbox-*` dirs remain** under the runs root. It does **not** assert that the container exited — so a regression where the host CLI dies but the container lives would pass CI.

**Expected contract:** When the user interrupts a Docker-backed run (SIGINT or SIGTERM on the host `jaiph` process):

1. The **`docker run` child** spawned by `spawnDockerProcess` (`src/runtime/docker.ts`) is terminated (same escalation as `setupRunSignalHandlers` in `src/cli/run/lifecycle.ts`: SIGINT → grace → SIGKILL).
2. The **container is gone** from `docker ps` within a bounded window (because `docker run --rm` is used, stopping the client should remove the container).
3. **Host cleanup still runs:** `cleanupDocker` removes copy-mode `.sandbox-*` clones (unless `JAIPH_DOCKER_KEEP_SANDBOX=1`); no new orphans under `.jaiph/runs/.sandbox-*`.
4. Applies to **copy, overlay, and inplace** modes — mode must not change the stop contract.

**Likely failure modes to investigate:**

* `onSignalCleanup` in `run.ts` calls `cleanupDocker` (rm sandbox dir) but nothing ensures the **container process** has stopped — cleanup and container lifecycle are decoupled.
* SIGINT kills the host `docker` CLI client while the container keeps running (Docker Desktop / detached behavior).
* Nested agent subprocesses (`claude`, long `npm test`) inside the container outlive the forwarded signal when the host `docker run` is interrupted.

**Implementation sketch:**

1. On interrupt, after `terminateRunProcessGroup(execResult.child)`, **await container exit** (or call explicit stop — e.g. kill the `docker run` child reliably, or `docker stop` the container ID captured from spawn if needed).
2. Ensure `cleanupDocker` runs **after** the container has stopped (or make cleanup idempotent and safe if the container is still winding down).
3. Wire the same behavior for MCP per-call Docker sandbox if it shares the gap (`src/cli/mcp/call.ts` uses `withDockerExitGuard` + `cancelRunProcess` — verify parity).

Acceptance:

* **New or extended e2e** (prefer extending `e2e/tests/74b_docker_signal_cleanup.sh` or sibling `74c`-style script): start a Docker-backed workflow that sleeps long enough to inspect (`sleep 60` script step, same fixture pattern as today); record `docker ps -q --filter ancestor=<test image>` or the container name/id while running; send SIGINT to the host `jaiph` PID; **`docker ps` must not list that container within 15s**; assert `.sandbox-*` cleanup still passes (existing assertion retained).
* **Regression e2e variant (optional but valuable):** reproduce with a workflow that spawns a **nested long-lived shell** (closer to agent behavior) — e.g. `script hang = \`sleep 60\`` inside `ensure` — and assert the same container-stop contract.
* Unit test in `src/cli/run/lifecycle.test.ts` or `src/runtime/docker.test.ts`: SIGINT handler invokes termination on the docker child (mock/spy `killProcessTree` or `_dockerSpawn`).
* Manual repro steps documented in test header comment: `jaiph run …` → Ctrl+C → `docker ps` empty.
* `npm test` and `npm run test:e2e` pass.

***

## UX: confirmation prompts for `--inplace` and `--unsafe` with explicit access scope #dev-ready

**Gap:** `--inplace` already gates launch behind an interactive warning + `Continue? [y/N]` (`confirmInplaceRun` in `src/runtime/docker-inplace.ts`, wired from `runWorkflow` in `src/cli/commands/run.ts`). **`--unsafe` / `JAIPH_UNSAFE=true` has no equivalent** — the run starts immediately on the host with no sandbox and no consent prompt. Users can opt into host-only mode without seeing how broad the blast radius is.

**Access model to communicate clearly in both prompts:**

| Mode | Sandbox | Filesystem reach | Network / env |
|---|---|---|---|
| **`--inplace`** | Docker **on** (container boundary, caps, env allowlist) | **Workspace directory only** — bind-mounted `:rw` at `/jaiph/workspace`; scripts/agents cannot read/write arbitrary host paths outside it | Same as any Docker run (egress on by default unless `JAIPH_DOCKER_NETWORK=none`; allowlisted env vars only unless `--env`) |
| **`--unsafe`** | Docker **off** — workflow runs as the host `jaiph` process | **Entire host filesystem** (and host `$HOME`, SSH agent, Keychain, etc.) — no mount restriction | Full host environment visible to scripts and agent backends |

The inplace prompt already says edits land in the workspace and "everything outside this directory stays sandboxed", but it should **lead with the access scope** in plain language (workspace-only vs whole machine). The unsafe prompt must be **stronger and scarier** than inplace — this is strictly more exposure, not a lighter variant.

**Required behavior:**

1. **`--unsafe` confirmation (new):** Before spawning a host-only run when `JAIPH_UNSAFE=true` / `--unsafe` is set (and Docker would otherwise be on), print a warning to stderr and require `Continue? [y/N]` on a TTY — default **no**. Abort cleanly on `n`/empty/EOF (same UX as inplace).
2. **Non-TTY unsafe:** mirror inplace — require an explicit auto-confirm flag (e.g. reuse `--yes` / `JAIPH_INPLACE_YES` **or** introduce `JAIPH_UNSAFE_YES` — pick one consistent story and document it; `--yes` applying to both modes is acceptable if documented).
3. **Refresh inplace copy:** restructure `formatInplaceWarning` so the **first** thing after the header states access scope: *"Filesystem access: this workspace directory only (`<path>`). The rest of your machine stays inside the Docker sandbox."* Keep git clean/dirty/no-repo middle paragraph. Fix the typo **"therest" → "the rest"** in the tail line.
4. **Unsafe copy (new `formatUnsafeWarning`):** header must state *host-only, no sandbox*, *filesystem access: entire machine*, and that scripts/agents can read secrets from the environment and reach paths outside the project. Optional git-state middle (same three variants) — dirty tree is especially dangerous on unsafe.
5. **Banner alignment:** `formatJaiphRunningBannerLines` already shows `(no sandbox)` for unsafe and `(Docker sandbox, in-place …)` for inplace — keep consistent with prompt wording.
6. **Out of scope for this task:** changing default-on Docker policy, MCP server startup consent (already documented separately), or credential pre-flight skip on unsafe (already skipped today).

**Implementation sketch:**

* Extend `src/runtime/docker-inplace.ts` (or rename/split to a neutral `run-confirm.ts`) with `confirmUnsafeRun`, shared `detectGitTreeState`, shared yes/no prompt seam (`_inplacePrompt` → generic `_runConfirmPrompt`).
* Call `confirmUnsafeRun` from `runWorkflow` when `resolveDockerConfig(...).enabled === false` due to unsafe (not when Docker is off for win32 platform override alone — decide: win32 is already host-only with a notice; optional to reuse unsafe prompt or skip with one-line notice only).
* Wire `--yes` through `applySandboxFlags` / env so it skips **both** confirmations when appropriate.

Acceptance:

* Unit tests in `src/runtime/docker-inplace.test.ts` (or renamed module): unsafe warning text mentions whole-filesystem / no sandbox; inplace warning mentions workspace-only scope; typo fixed; TTY yes/no/empty; non-TTY throws without auto-confirm flag; auto-confirm skips prompt.
* `src/cli/commands/run.test.ts`: host-only run with `--unsafe` and no `--yes` on non-TTY exits before spawn; with `--yes` proceeds.
* E2e (new small script or extend an existing host-only test): `--unsafe` without `--yes` in non-interactive context fails with actionable error code/message (mirror `E_DOCKER_INPLACE_NO_CONFIRM` pattern → e.g. `E_UNSAFE_NO_CONFIRM`).
* `docs/cli.md`, `docs/env-vars.md`, and `docs/sandboxing.md` document both prompts, access scopes, and `--yes` / auto-confirm env vars.
* `npm test` passes.

***
