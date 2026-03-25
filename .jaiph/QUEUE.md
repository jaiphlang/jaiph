# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

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

## Refactor validate.ts — collapse duplicate ref resolution <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 0a.

**Goal.** Reduce `validate.ts` from ~788 lines to ~400 by merging 5 near-identical ref resolution functions into one generic resolver.

**Scope.**

1. Merge `validateRuleRef`, `validateWorkflowRef`, `validateRunInRuleRef`, `validateRunTargetRef`, and `validateBareSendSymbol` into a single `validateRef(ref, allowedKinds, context)` function that takes the set of allowed target kinds and produces the appropriate error for each mismatch.
2. Each call site passes its constraints (which kinds are allowed, which error messages to emit for mismatches).
3. Keep all existing error messages and validation behavior identical.
4. No new features — pure structural refactor.

**Acceptance criteria.**

- `validate.ts` is under 500 lines.
- All existing validation tests pass unchanged.
- Error messages remain identical (verify via golden test output and e2e).
- `npm run build && npm test && npm run test:e2e` pass.

---

## Split emit-workflow.ts — separate rule and script emitters <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 0b.

**Goal.** Break the ~399-line `emitWorkflow` monolith into focused emitters: one for scripts (currently `function`), one for rules, and the remaining orchestration assembly in `emit-workflow.ts`.

**Scope.**

1. Extract the function/script emission loop into `emit-script.ts` with an `emitScriptFunctions(ast, workflowSymbol, ...)` export.
2. Extract the rule emission loop into `emit-rule.ts` with an `emitRuleFunctions(ast, workflowSymbol, ...)` export.
3. `emit-workflow.ts` imports both, calls them, and assembles the final output string.
4. No behavioral change — output bash must be byte-identical before and after.

**Acceptance criteria.**

- `emit-workflow.ts` is under 250 lines (orchestration + boilerplate only).
- `emit-script.ts` and `emit-rule.ts` exist with single-responsibility emitters.
- Golden test output is byte-identical before and after.
- `npm run build && npm test && npm run test:e2e` pass.

---

## Rename `function` → `script` keyword <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 3a, 3e.

**Goal.** Replace the `function` keyword with `script` across the entire codebase: parser, AST, transpiler, all `.jh` files, tests, and fixtures.

**Scope.**

1. **Parser** (`parse/functions.ts` → rename file to `parse/scripts.ts`): change regex from `/^function\s+/` to `/^script\s+/`.
2. **AST** (`types.ts`): rename `FunctionDef` → `ScriptDef`, rename `jaiphModule.functions` → `jaiphModule.scripts`.
3. **Transpiler**: update all references from `functions` to `scripts`, `FunctionDef` to `ScriptDef` in `emit-workflow.ts` (or `emit-script.ts` after split), `validate.ts`, `emit-test.ts`.
4. **Parser entry** (`parser.ts`): detect `script` keyword instead of `function`.
5. **All `.jaiph/*.jh` files**: rename `function` → `script` keyword.
6. **All `e2e/*.jh` fixtures**: rename keyword.
7. **Test fixtures and golden outputs**: update for `script` keyword.
8. **Error messages**: update to reference "script" instead of "function".

**Acceptance criteria.**

- `function` keyword is no longer accepted by the parser.
- `script` keyword parses and transpiles identically to former `function` (aside from keyword name in errors).
- All `.jh` files use `script` keyword.
- `npm run build && npm test && npm run test:e2e` pass.

---

## Add shebang support and separate file transpilation

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 3b, 3c, 3d.

**Goal.** Scripts transpile to standalone executable files with `+x` permission. Users can provide a custom shebang (e.g. `#!/usr/bin/env node`) as the first line of the script body; otherwise `#!/usr/bin/env bash` is used.

**Scope.**

1. **AST**: add `shebang?: string` field to `ScriptDef`.
2. **Parser**: check first non-empty line of script body for `#!`. If present, store in `shebang` and exclude from body commands.
3. **Keyword guard**: for bash scripts (no shebang or `#!/usr/bin/env bash` shebang), keep Jaiph keyword rejection. For custom shebangs, skip the guard.
4. **Emit**: change `emitWorkflow` return type to `{ module: string; scripts: Array<{ name: string; content: string }> }`. Script file content = shebang line + body.
5. **Build**: `build.ts` writes each script to `build/scripts/<name>`, sets `chmod +x`. Module `.sh` calls scripts via `"$JAIPH_SCRIPTS/<name>" "$@"`.
6. **Runtime**: set `$JAIPH_SCRIPTS` env var in lifecycle/stdlib to point to build scripts directory.
7. **E2e test**: add test with a custom shebang script (e.g. `#!/usr/bin/env node` or `#!/usr/bin/env python3`) that validates the polyglot model works end-to-end.

**Acceptance criteria.**

- Scripts emit as separate files under `build/scripts/` with `+x`.
- Default shebang is `#!/usr/bin/env bash` when none specified.
- Custom shebang (e.g. `#!/usr/bin/env node`) is correctly placed in the output file.
- Jaiph keyword guard is skipped for non-bash shebangs.
- Module `.sh` correctly invokes scripts by path.
- `$JAIPH_SCRIPTS` is set at runtime.
- E2e test with custom shebang script passes.
- All existing tests pass.

---

## Implement script isolation and shared library support

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 4.

**Goal.** Scripts execute in full isolation — only positional arguments, no inherited variables. Shared utility code is loaded via `$JAIPH_LIB`.

**Scope.**

1. **Script isolation.** With separate-file transpilation (previous task), isolation is largely inherent — scripts run as separate processes via `exec`. Verify that no environment variables leak from the calling module beyond `$JAIPH_LIB` and `$JAIPH_SCRIPTS`. If needed, wrap calls with `env -i` or equivalent.
2. **`$JAIPH_LIB` runtime support.** The runtime sets `$JAIPH_LIB` to the project's shared library path (e.g. `.jaiph/lib/` relative to workspace root) before script execution. Bash scripts can `source "$JAIPH_LIB/utils.sh"`.
3. **Validate no cross-script calls.** Parser or validator: detect when a script body references another Jaiph script by its transpiled name. Emit error: `"scripts cannot call other Jaiph scripts; use a shared library or compose in a workflow"`.
4. **Verify `.jaiph/lib/` shared libraries work end-to-end.** The shared libraries (`checks.sh`, `strings.sh`) must be loadable from scripts and work correctly under isolation.

**Acceptance criteria.**

- Scripts cannot access parent scope variables (test: script that tries to read a `const` from the calling workflow gets empty string or error).
- `$JAIPH_LIB` is set correctly during script execution.
- `source "$JAIPH_LIB/..."` works from within isolated scripts.
- Cross-script call detection works (parser/validator error on reference to another Jaiph script).
- All existing tests still pass.
- E2e test added: script isolation verified (script cannot read caller variables).

---

## Rewrite docs for script terminology and present-tense language

**Goal.** Update all user-facing docs to use `script` terminology (replacing `function`) and remove historical transition framing.

**Scope.**

1. Sweep docs (`README.md`, `docs/*.md`, `docs/index.html`, `docs/jaiph-skill.md`) and replace `function` (Jaiph construct) references with `script`.
2. Add documentation for custom shebang support and polyglot script model.
3. Remove wording that frames rules/scripts as transitions ("no longer", "legacy syntax", "migration patterns").
4. Rewrite those passages to present-tense contracts (what is valid, what is rejected).
5. Keep changelog entries historical. Keep semantics unchanged.

**Acceptance criteria.**

- All docs reference `script` keyword, not `function`.
- Shebang and polyglot model are documented.
- Reference docs read as current behavior contracts, not migration guides.
- Build/tests still pass after wording changes.

---

## Post-refactor sweep: dead code removal and docs cleanup

**Goal.** After the script migration phases are complete, remove residual rewrite-era code and perform one final docs consistency sweep.

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
