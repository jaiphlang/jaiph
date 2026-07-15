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
