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

