# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Remove shell from compiler, migrate all fixtures, pass all tests <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — sections: Legality Matrix (all three), Implementation Plan Phases 2–4, Code Changes Required, Migration Examples, Pattern Catalog (all P1–P11).

**Goal.** One-shot breaking cutover: (1) rules become structured (no raw shell), (2) workflows lose shell fallback, (3) functions enforce pure bash, (4) all `.jh` fixtures are migrated, (5) all tests pass. This task is indivisible — the compiler changes and fixture migration must land together.

**Scope — Compiler changes.**

1. **Rule parser rewrite.**
   - Change `RuleDef` in `src/types.ts`: replace `commands: string[]` with `steps` array (reuse `WorkflowStepDef` subset or define `RuleStepDef`).
   - Rewrite `src/parse/rules.ts` with keyword-aware parsing mirroring `src/parse/workflows.ts`. Rules support: `const`, `ensure` (other rules only, no `recover`), `run` (functions only, not workflows), `log`, `logerr`, `return "value"`, `fail "reason"`, brace-style `if`.
   - Rules do NOT support: `prompt`, routing/send, async, `recover`.
   - Rewrite rule emission in `src/transpile/emit-workflow.ts` to handle structured steps instead of opaque command strings.
   - Update `src/transpile/validate.ts`: allow `run` in rules targeting functions only.

2. **Remove shell fallback from workflows.**
   - `src/parse/workflows.ts`: delete the catch-all `type: "shell"` codepath and the `shellAccumulator`/`braceDepthDelta` shell accumulation.
   - Emit parser error with rewrite guidance: `"raw shell is not allowed in workflow; extract to a function"`.
   - Remove old `if ... then ... fi` syntax (only brace-style `if` accepted).
   - Remove shell condition form from `if` (`if ! command; then`).

3. **Enforce function purity.**
   - `src/parse/functions.ts`: reject Jaiph `return "value"` in function bodies (only allow `return N` where N is an integer or `$?`).
   - Remove `jaiph::set_return_value` from function transpilation paths in `src/transpile/emit-workflow.ts`.
   - Reject Jaiph keywords (`fail`, `const`, `log`, `logerr`) in function bodies.

4. **Update send operator.**
   - Send RHS accepts: `"value"` / `$var` / `run ref`. Reject raw shell as RHS.

5. **Scope down or remove `src/transpile/shell-jaiph-guard.ts`** — shell only exists in functions now.

**Scope — Fixture migration (must happen in the same task).**

6. **Rewrite all `e2e/*.jh` files** to new syntax:
   - `local` → `const` in workflows
   - Raw shell → extract to named `function` blocks
   - `if ... then ... fi` → brace-style `if`
   - `exit 1` → `fail`, `exit 0` → `return`
   - `return "value"` in functions → stdout passthrough (`echo`/direct output)
   - See spec Migration Examples for before/after patterns for every common case.

7. **Update test fixtures** (`test/fixtures/*.jh`) to new syntax.

8. **Regenerate golden expected outputs.** Run `scripts/dump-golden-output.js` to regenerate `test/expected/` files.

9. **Update acceptance tests** (`test/acceptance/`) if any test raw-shell parsing behavior that no longer exists.

10. **Run full test suite**: `npm run build && npm test && npm run test:e2e`. Fix any failures.

**Do NOT change.**
- Reporting infrastructure (`src/reporting/`)
- Run directory structure and artifacts
- e2e test helpers (`e2e/lib/common.sh`)
- Test infrastructure (test runners, e2e harness)
- Only change e2e test SCRIPTS (`e2e/tests/*.sh`) if the expected output changed due to syntax changes (e.g. step names, error messages)

**Compiler files to change.** `src/types.ts`, `src/parse/rules.ts` (full rewrite), `src/parse/workflows.ts`, `src/parse/functions.ts`, `src/transpile/emit-workflow.ts`, `src/transpile/emit-steps.ts`, `src/transpile/validate.ts`, `src/transpile/shell-jaiph-guard.ts`.

**Acceptance criteria.**

- Rules parse with structured keywords. Raw shell in rules produces a parser error.
- Workflows reject raw shell with actionable error messages.
- Functions reject `return "value"`, `fail`, `const`, `log`, `logerr`.
- `jaiph::set_return_value` is gone from function transpilation.
- Send operator accepts only `"value"` / `$var` / `run ref`.
- Old `if ... then ... fi` no longer parses. Only brace-style accepted.
- All `e2e/*.jh` and `test/fixtures/*.jh` files use new syntax exclusively.
- `npm run build` passes.
- `npm test` passes (including golden output comparison).
- `npm run test:e2e` passes.
- Reporting and run directory behavior unchanged.
- Zero raw shell in any workflow or rule across the entire codebase.

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
