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

## Fix: unquoted `${ref}` string sugar everywhere Jaiph accepts strings #dev-ready

**Global rule:** Every Jaiph string position — not only `config { }` — must accept the same three equivalent forms: **bare identifier** (`model`), **double-quoted string** (`"${model}"` or `"prefix-${model}"`), and **bare unquoted interpolation ref** (`${model}` or `${model.field}`). No string RHS site may accept two of these but reject the third. Audit the full parser surface; do not stop at config.

**Bug (first reported):** In `config { }`, `agent.model = "${model}"` and `agent.model = model` compile, but `agent.model = ${model}` is `E_PARSE` (`config value must be a quoted string, bare identifier, or true/false: ${model}`).

**Root cause:** String RHS parsers inconsistently implement sugar. `parseMetadataValue` (`src/parse/metadata.ts`) and siblings only recognize quoted strings and bare identifiers; a RHS that already starts with `${` falls through to a parse error. The same asymmetry may exist on other sites that already accept bare `name` and `"${name}"` but not bare `${name}`.

**Required behavior (uniform sugar, all string sites):**

| Author writes | Stored / AST form | Resolves at runtime |
|---|---|---|
| `model` | `${model}` | yes |
| `"${model}"` | `${model}` (string content) | yes |
| `${model}` | `${model}` | yes |
| `"prefix-${model}"` | literal with embedded ref | yes |
| `${model.field}` | `${model.field}` | yes |

**All string usage sites to audit and align** (exhaustive pass — every parser that accepts a Jaiph orchestration string, not a raw shell fragment):

1. **Module/workflow `config { }` string keys** — `parseMetadataValue` (`src/parse/metadata.ts`).
2. **`log` / `logerr` / `fail` message RHS** — `parseLogMessageRhs` and siblings (`src/parse/core.ts`, `workflow-brace.ts`).
3. **`const x = …` string literal RHS** — `parseConstRhs` (`src/parse/const-rhs.ts`).
4. **`return` value sugar** — `workflow-return-dotted.ts` / return parsing in `workflow-brace.ts`.
5. **`prompt` body** — identifier and quoted forms (`src/parse/prompt.ts`): `prompt model`, `prompt "${model}"`, and `prompt ${model}` must be equivalent where a single-ref prompt is intended.
6. **`send` RHS** — `parseSendRhs` (`src/parse/send-rhs.ts`) already accepts `${var}`; ensure parity with bare-identifier sugar where applicable.
7. **`match` arms, `if` string operands, call literal args, channel payloads** — any other `src/parse/*.ts` path that accepts `"…"` or bare identifiers for interpolation; grep for `isBareIdentifier`, `bareIdentifier`, and string-RHS parse errors to find gaps.
8. **Formatter round-trip** — `emitConfigStringRhs` and any other emit paths (`src/format/emit.ts`): `jaiph format` preserves author intent (bare id preferred when equivalent).

Explicitly **out of scope:** script bodies (backtick/fenced shell), `*.test.jh` mock literals where documented as quote-only, and shell expansions (`${var:-default}`, `${#var}`, etc.) — keep `validateJaiphStringContent` / `validateConstBashExpr` guards.

**Implementation sketch:**

- Add one shared helper (e.g. `isJaiphInterpolationRef` in `src/parse/core.ts`): `^\$\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}$`.
- Route every string RHS parser through the same normalization (bare id → `${name}`, unquoted `${name}` → stored as-is, quoted forms unchanged).
- Extend compile-time validation (`src/transpile/validate-config.ts` and any string-ref validators) so all three forms resolve identically.

Acceptance:

* **Config:** `jaiph compile` accepts `config { agent.model = ${model} }` at module and workflow scope; stored metadata equals `${model}`; runtime resolves at prompt time (`e2e/tests/87_workflow_config.sh` or `node-workflow-runtime.artifacts.test.ts`).
* **Parser unit tests:** `parse-metadata.test.ts` — unquoted `${model}`, `${model.field}`; reject unclosed `${model` and shell `${model:-x}`. `parse-const-rhs.test.ts`, `parse-definitions.test.ts`, `parse-prompt.test.ts`, `parse-send-rhs.test.ts` (as applicable) — each covered site accepts bare id, quoted, and unquoted `${ref}` with identical AST/normalization.
* **Cross-site lint or inventory test:** a test that fails if any `src/parse/*.ts` string-RHS parser duplicates the bare-id / quoted pattern without calling the shared helper (prevents future drift).
* `compiler-golden.test.ts` / txtar snapshot updated for the new accepted form.
* `docs/configuration.md`, `docs/grammar.md`, and `docs/language.md` string-interpolation sections state the global three-form rule for **all** Jaiph string positions.
* `npm test` passes.

***

## Release: bump version to 0.11.0 #dev-ready

Cut release **v0.11.0** from the current `# Unreleased` changelog block. The supported mechanical path is `.jaiph/prepare_release.jh`; the operator still reviews the diff, stamps the changelog, commits, tags, and pushes.

Steps:

1. Ensure the git tree is clean and `# Unreleased` in `CHANGELOG.md` contains every change shipping in this release.
2. Run `jaiph run .jaiph/prepare_release.jh -- 0.11.0` (bumps `package.json` + `package-lock.json`, refreshes the pinned `v0.10.0` → `v0.11.0` ref in **both** `docs/install` and `docs/install.ps1` in lockstep, rebuilds, asserts `jaiph --version` matches, regenerates `docs/registry`).
3. Stamp `CHANGELOG.md`: rename `# Unreleased` → `# 0.11.0`, add a `## Summary` section with 3–6 bullets capturing the headline themes (MCP server + Docker parity, `--env` passthrough, config interpolation + `agent.model` breaking changes, Windows portability/distro), keep the existing `## All changes` bullets under the new version header, and leave a fresh empty `# Unreleased` section at the top.
4. Update remaining user-facing version literals still pinned to `0.10.0` where they denote the current stable release: `docs/index.html`, `README.md`, `docs/setup.md`, `docs/env-vars.md` (`JAIPH_REPO_REF` default), and any other docs/examples found by `rg '0\\.10\\.0' docs README.md`.
5. Commit as `Release: bump version to 0.11.0 and stamp changelog`. Tag `v0.11.0` and push branch + tag (tag push triggers release workflow).

Acceptance:

* `package.json` and `package-lock.json` report `0.11.0`; `node dist/src/cli.js --version` prints `jaiph 0.11.0`.
* `docs/install` and `docs/install.ps1` default to `v0.11.0` with zero remaining `v0.10.0` pins in either installer.
* `CHANGELOG.md` has `# Unreleased` (empty) at the top and a stamped `# 0.11.0` section with both `## Summary` and `## All changes`.
* `rg '0\\.10\\.0' docs README.md` finds no stale "current release" literals (historical mentions inside older changelog sections are fine).
* `.jaiph/prepare_release.test.jh` and `integration/installer-powershell.test.ts` still pass (`npm test`).

***

## Run tree: show model on prompt step lines (`prompt backend model "…"`) #dev-ready

The live run tree and non-TTY step labels currently render prompt steps as `▸ prompt claude "Say hello…"` / `✓ prompt claude (5s)` — backend only, no model. Model is already resolved at prompt time (`resolveModel` in `src/runtime/kernel/prompt.ts`) and recorded on `PROMPT_START` / `PROMPT_END` in `run_summary.jsonl`, but it never reaches the `STEP_START`/`STEP_END` display path (`formatStartLine` / `formatCompletedLine` in `src/cli/run/display.ts`, fed by `resolvePromptStepName` in `src/runtime/kernel/prompt.ts` via `stderr-handler.ts`).

Change the **display contract** so prompt step lines include the effective model when one is known:

* **Start (TTY + non-TTY):** `▸ prompt <backend> <model> "…preview…"` — e.g. `▸ prompt claude sonnet "Classify this task…"`.
* **End:** `✓ prompt <backend> <model> (<time>)` — e.g. `✓ prompt claude sonnet (5s)`.
* **Model source:** the same value already passed to the backend for that invocation (explicit `agent.model` / `JAIPH_AGENT_MODEL` / flag-derived / backend default — whatever `resolveModel` returns with a non-empty `model` string).
* **Omit model token** when `resolveModel` yields no model (empty / unknown) — fall back to today's two-token form `prompt <backend> "…"`.
* **Custom `agent.command`:** keep showing the command basename as today; append model after it when known (`prompt my-agent sonnet "…"`).
* **Do not change** the `.jh` language — this is CLI/run-tree presentation only. `config { agent.model = … }` remains the authoring surface.

Implementation sketch:

1. Extend prompt step metadata on `STEP_START`/`STEP_END` (or the event `params`/`name` assembly in `node-workflow-runtime.ts` / `runtime-event-emitter.ts`) so the display layer receives backend + model without re-resolving.
2. Update `formatStartLine` and `formatCompletedLine` (and heartbeat if it shows prompt name) to render the three-part label.
3. Keep truncation rules: existing preview (24 chars) and 96-char line cap unchanged; model is a bare token between backend and quoted preview.

Acceptance:

* Unit tests in `src/cli/run/display.test.ts` cover start/end lines with backend+model, backend-only (no model), and custom-command basename + model.
* `src/runtime/kernel/node-workflow-runtime.artifacts.test.ts` (or a focused new test) asserts `STEP_START` for a prompt includes enough fields for the display layer to render model without reading `PROMPT_START`.
* E2E `e2e/tests/20_rule_and_prompt.sh` (or a new small e2e) updated so stdout expectations match `prompt cursor <model> "…"` when model is configured or defaulted — test fails if model is dropped from the line.
* `docs/first-agent-run.md` and `docs/cli.md` run-tree examples updated to show the three-part prompt label.
* `npm test` passes.

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

