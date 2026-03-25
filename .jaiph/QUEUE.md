# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Rewrite docs wording to present-tense language truth <!-- dev-ready -->

**Goal.** Remove historical transition framing from user-facing docs and describe the language in current-state terms only.

**Scope.**

1. Sweep docs (`README.md`, `docs/*.md`, `docs/index.html`, `docs/jaiph-skill.md`) for wording that frames rules as transitions (examples: "no longer", "legacy syntax", "migration patterns", "migrate to").
2. Rewrite those passages to present-tense contracts (what is valid, what is rejected), without "before vs after" narration.
3. Keep changelog entries historical (do not rewrite release history), but ensure reference docs and guides are state-only.
4. Keep semantics unchanged; wording-only task unless a statement is factually wrong.

**Acceptance criteria.**

- Reference docs read as current behavior contracts, not migration guides.
- No "legacy/migration/no longer" phrasing in current-state sections of README and docs.
- Build/tests still pass after wording changes.

---

## Remove dead code after language redesign rewrite <!-- dev-ready -->

**Goal.** Remove parser/transpiler/runtime code paths that only existed for transitional compatibility and are now redundant.

**Scope.**

1. Identify dead or unreachable compatibility code related to old orchestration syntax and shell fallbacks.
2. Remove unused parser helpers, validator branches, and transpiler glue that are no longer referenced.
3. Remove stale tests that only assert transitional compatibility behavior.
4. Keep behavior and public contracts unchanged.

**Acceptance criteria.**

- No dead compatibility branches remain for removed syntax paths.
- Typecheck/build/tests/e2e pass with no regressions.
- Diff includes only removals/refactors justified by current parser/runtime behavior.

---

## Implement function isolation and shared library support <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — sections: Function Isolation Model, Design Decisions #10–12.

**Goal.** Functions execute in full isolation — only positional arguments, no inherited variables. Shared utility code is loaded via `$JAIPH_LIB`.

**Scope.**

1. **Function isolation.** Transpile function execution so the function body runs in a clean environment. Only `$1`, `$2`, etc. and `$JAIPH_LIB` are available. Implementation options: `env -i` wrapper, subshell with explicit variable clearing, or equivalent restricted context. Choose the approach with lowest overhead.

2. **`$JAIPH_LIB` runtime support.** The runtime sets `$JAIPH_LIB` to the project's shared library path (e.g. `.jaiph/lib/` relative to workspace root) before function execution. Functions can `source "$JAIPH_LIB/utils.sh"` to load shared code.

3. **Validate no cross-function calls.** Parser or validator: detect when a function body references another Jaiph function by its transpiled name. Emit error: `"functions cannot call other Jaiph functions; use a shared library or compose in a workflow"`.

4. **Verify `.jaiph/lib/` shared libraries work end-to-end.** The shared libraries created in task 1 (`checks.sh`, `strings.sh`) must be loadable from functions and work correctly under isolation.

**Acceptance criteria.**

- Functions cannot access parent scope variables (test: function that tries to read a `const` from the calling workflow gets empty string or error)
- `$JAIPH_LIB` is set correctly during function execution
- `source "$JAIPH_LIB/..."` works from within isolated functions
- Cross-function call detection works (parser/validator error on reference to another Jaiph function)
- All existing tests still pass
- E2e test added: function isolation verified (function cannot read caller variables)

---

## Post-refactor sweep: dead code removal and docs cleanup <!-- dev-ready -->

**Goal.** After the language refactor phases are complete, remove residual rewrite-era code and perform one final docs consistency sweep.

**Scope.**

1. Remove dead parser/transpiler/runtime helpers that were kept during the refactor but are now unused.
2. Remove temporary compatibility tests/fixtures/messages that no longer protect active behavior.
3. Run a full docs consistency pass across `README.md`, `docs/*.md`, `docs/index.html`, and `docs/jaiph-skill.md` so terminology matches the final grammar/runtime.
4. Eliminate duplicate or contradictory wording between Grammar, CLI, Getting Started, and the skill docs.
5. Keep changes focused on cleanup (no new feature work).

**Acceptance criteria.**

- No unused refactor-era branches/helpers remain in active code paths.
- Docs are internally consistent and aligned with shipped behavior.
- `npm run build && npm test && npm run test:e2e` pass after cleanup.
- Diff is cleanup-only (removals, wording consistency, and minimal wiring fixes).

---

## Reporting server does not mark SIGKILL-terminated runs as ended <!-- dev-ready -->

**Problem.** When `jaiph run` is killed by SIGKILL (or any signal that prevents the normal `WORKFLOW_END` event from being written to `run_summary.jsonl`), the reporting server (`jaiph report`) continues to show the run as active/in-progress indefinitely. There is no `WORKFLOW_END` event to trigger transition to a terminal state.

**Goal.** The reporting server should detect runs that will never complete and mark them as failed/terminated in the UI.

**Approach (investigate and pick one).**

1. **Stale-run detection** — The server already polls `run_summary.jsonl`. If a run has had no new events for a configurable timeout (e.g. `JAIPH_REPORT_STALE_RUN_SEC`, default 120s) and the originating process is no longer alive, mark the run as terminated/stale in the API and UI.
2. **PID-file or lock-file approach** — `jaiph run` writes a PID file (or holds a lock) in the run directory. The reporting server checks whether that PID is still alive; if not, the run is dead.
3. **Hybrid** — Combine timeout heuristic with PID liveness check for reliability.

**Acceptance criteria.**

- A run killed with `kill -9` (SIGKILL) is eventually shown as failed/terminated in `jaiph report`, not stuck as active forever.
- Normal runs that complete with `WORKFLOW_END` are unaffected.
- The detection mechanism has a reasonable latency (under 2–3 poll cycles).
- E2e or integration test: start a run, kill it with SIGKILL, verify `GET /api/active` eventually returns empty and `GET /api/runs` shows the run as failed/terminated.

---
