# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Rewrite .jaiph/ workflows to new language syntax

**Spec**: `.jaiph/language_redesign_spec.md` — read the ENTIRE spec before starting. Every design decision, syntax rule, and migration pattern is documented there.

**Goal.** Rewrite all `.jaiph/*.jh` files to conform to the new language syntax defined in the spec. These files will NOT parse until the compiler is updated in subsequent tasks — that is expected and intentional.

**What changes.**

- `local` declarations in workflows/rules → `const`
- All raw shell in workflows → extract to named `function` blocks
- All raw shell in rules → extract to named `function` blocks, rules become structured (use `run`, `ensure`, `if`, `fail`, `log`, `logerr`, `return`)
- `if ... then ... fi` / `elif` → `if ... { } else if ... { } else { }` with `not` for negation
- `exit 1` in workflows → `fail "reason"`
- `exit 0` in workflows → `return`
- `return "$(command)"` in functions → let stdout flow through (remove Jaiph `return`, use `echo`/direct output)
- Module-level `local` → `const`
- Function bodies must be self-contained: no references to module-level variables, no calls to other Jaiph functions. Data the function needs must be defined inside the function body or received as positional arguments.
- Create `.jaiph/lib/` directory with shared bash utility libraries (e.g. `checks.sh` for `has_value`, `matches`, `is_zero`; `strings.sh` for `first_line`, `rest_lines`). Functions `source "$JAIPH_LIB/..."` to use them.
- Iteration patterns (architect_review.jh, docs_parity.jh): use workflow recursion with `first_line`/`rest_lines` from shared lib. See spec section P3 for the exact pattern.
- engineer.jh: move role descriptions into the `select_role` function body. See spec "Prompt with returns + value dispatch" migration example.

**Files to rewrite.** queue.jh, docs_parity.jh, simplifier.jh, architect_review.jh, engineer.jh, ensure_ci_passes.jh, qa.jh, git.jh, main.jh.

**Acceptance criteria.**

- All `.jaiph/*.jh` files use the new syntax exclusively (zero raw shell in workflows/rules, `const` not `local`, brace-style `if`, `fail` not `exit 1`)
- `.jaiph/lib/` exists with shared utility functions
- All functions are self-contained (no module-level variable references, no cross-function calls)
- `return "$(…)"` patterns in functions replaced with stdout passthrough
- Files are syntactically consistent with the spec's legality matrix

**Note.** These files will fail to parse until the compiler tasks below are completed. That is expected. Do NOT modify the compiler in this task.

---

## Add new language constructs to compiler: `fail`, `const`, `wait`, brace-style `if`

**Spec**: `.jaiph/language_redesign_spec.md` — sections: Design Decisions, Legality Matrix (workflow), Semantics, Implementation Plan Phase 1.

**Goal.** Add four new constructs to the workflow parser and transpiler. This task adds capabilities without removing anything — old syntax still parses after this task.

**Scope.**

1. **`fail "reason"`** — new step type in workflows.
   - AST: add `{ type: "fail"; message: string; loc: SourceLoc }` to `WorkflowStepDef` in `src/types.ts`.
   - Parser (`src/parse/workflows.ts`): recognize `fail "reason"` as a new keyword.
   - Transpiler (`src/transpile/emit-steps.ts`): emit `echo "reason" >&2; exit 1`.
   - Add parser test, golden fixture, and e2e test for `fail`.

2. **`const name = ...`** — new declaration in workflows.
   - AST: add `{ type: "const"; name: string; ... }` to `WorkflowStepDef`.
   - Parser: `const name = "value"` / `const name = run ref` / `const name = ensure ref` / `const name = prompt "text"`.
   - Transpiler: emit `local name; name="value"` or the appropriate capture form (same as existing `var = run/ensure/prompt` but with `const` keyword).
   - Allowed RHS values: string literals, `$var`, `"${var:-default}"`, keyword captures. NOT allowed: `$(command)`, `"${var%%pattern}"`. See spec P10.

3. **`wait`** — formalize as a keyword instead of shell fallback.
   - AST: add `{ type: "wait"; loc: SourceLoc }`.
   - Parser: recognize bare `wait` in workflows.
   - Transpiler: emit `wait`.

4. **Brace-style `if`** — replace `if ... then ... fi`.
   - New syntax: `if [not] ensure ref [args] { ... } [else if ...] [else { ... }]` and `if [not] run ref [args] { ... }`.
   - `not` replaces `!`. `else if` replaces `elif`. Braces `{ }` replace `then`/`fi`.
   - Implement as new parsing path alongside existing `if ... then` (both work after this task).
   - Shell condition form (`if ! command; then`) is NOT supported in the new syntax.

**Files to change.** `src/types.ts`, `src/parse/workflows.ts`, `src/transpile/emit-steps.ts`, `src/transpile/emit-workflow.ts`. Add test fixtures in `test/fixtures/` and expected output in `test/expected/`.

**Acceptance criteria.**

- `fail "reason"` parses and transpiles correctly in workflows. E2e test: workflow with `fail` exits non-zero with message on stderr.
- `const name = "value"` and `const name = run/ensure/prompt` parse and transpile correctly. Existing `var = run/ensure/prompt` still works.
- `wait` parses as a keyword (not shell fallback). Transpiles to `wait`.
- New brace-style `if` parses and transpiles correctly with `not`, `else if`, `else`. Old `if ... then ... fi` still works.
- All existing tests pass (zero regressions).
- New golden fixtures added for each new construct.

---

## Remove shell from compiler, migrate all fixtures, pass all tests

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

## Implement function isolation and shared library support

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
