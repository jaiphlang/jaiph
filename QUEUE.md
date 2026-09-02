# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, **orchestration** removes that section (`queue.remove_completed_task` in `.jaiph/engineer.jh`). Agents and humans implementing a task must **not** edit `QUEUE.md` to delete or rewrite the current task — leave queue updates to the workflow.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Sequential `const` visibility: use-before-decl is `E_VALIDATE` #dev-ready

Context: Docs (`docs/language.md` Nested declarations / `const`) say local bindings are sequential, not hoisted. Nested `run foo()` before `script foo = …` is already `E_VALIDATE` via `localsSoFar` in `src/transpile/validate.ts`. Ordinary `const` is not. `walkStepTree` adds every `const` name to `knownVars` for the whole def, then `${name}` (`src/transpile/validate-string.ts`) and bare call args (`src/transpile/validate-step-helpers.ts`) consult that full set.

Problem: this compiles today and interpolates empty at runtime:

```
export def main() {
  log "${later}"
  const later = "ok"
}
```

Same hole for a bare identifier arg (`run consumer(later)` before `const later = …`) and for a nested def body that interpolates an enclosing `const` declared *after* the nested `def` (forward-const TDZ: validates, runtime `""`).

Remediation — implement exactly this:

1. Track a sequential visible-`const` set the same way `localsSoFar` tracks nested decls. A `${name}` / bare-arg / `if`/`match` subject that names a `const` not yet declared in the current step list is `E_VALIDATE` (unknown identifier), same message family as today's unknown-identifier errors.
2. When validating a nested `def` or nested named `prompt` body, `${…}` of enclosing `const`s may see only consts declared *before* that `local_decl` (snapshot at the declaration point). Params of the enclosing def are visible. Module-level `const`s stay visible.
3. Do not invent a new diagnostic code. Do not change runtime interpolation of a missing var (still empty) — the point is compile-time rejection.
4. Docs: one sentence in `docs/language.md` under `const` and Nested declarations stating use-before-decl is `E_VALIDATE` for interpolation and call args, not only for `run`/`prompt` targets.

### Acceptance criteria
- `export def main() { log "${later}"; const later = "ok" }` is `E_VALIDATE` naming `later` (`validate-nested-decl.test.ts` or a dedicated validate test; today's tree must fail this case).
- `export def main() { run consumer(later); const later = "ok" }` (with `def consumer(v)`) is `E_VALIDATE` naming `later`.
- `export def main() { def helper() { return "${later}" }; const x = run helper(); const later = "hi"; return x }` is `E_VALIDATE` naming `later` inside `helper`.
- `export def main() { const later = "ok"; log "${later}" }` still validates and a runtime test still prints `ok`.
- Nested `run foo()` before `script foo = …` stays `E_VALIDATE` (existing test must keep passing).
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Nested decls inside `if` / `for` / `catch` / `recover` are not visible outside that body #dev-ready

Context: A nested `script` / `def` / `prompt` is a `local_decl` step. `validateDefTree` (`src/transpile/validate.ts`) walks the flat step tree and adds every `local_decl` to `localsSoFar` regardless of branch. `localPromptReturnsResolver` (`src/transpile/validate-local-decl.ts`) only scans top-level `def.steps`, so a `returns` nested prompt inside `if` is invisible to `${r.field}` validation.

Problem: this validates, then fails at runtime when the branch is not taken:

```
export def main(flag) {
  if flag == "y" {
    script s = `echo YES`
  }
  return run s()
}
```

Two legal product choices exist. Pick **one** and implement it end to end (docs + tests). Preferred default: **ban** nested `script` / `def` / named `prompt` inside `if` / `for` / `catch` / `recover` (`E_VALIDATE` or `E_PARSE` naming the construct). Nested `const` already exists as a step and may stay. Alternative: control-flow–sensitive visibility (a name declared only in `if` is not visible after the `if`; `if`/`else` both declaring the same name is `cannot rebind` or a merge rule you document). Do not leave today's "validates, runtime miss" behavior.

Also fix `localPromptReturnsResolver` to match the chosen rule: either it never needs to see in-branch prompts (ban), or it walks the same visible set as `run`/`prompt` resolution.

### Acceptance criteria
- The `flag` example above is rejected at compile time (ban) **or** validates only when `run s()` is inside the same `if` body (sensitive). A unit test fails on today's tree.
- `if`/`else` both declaring `script s` is either two independent locals (sensitive, each body) or a compile error (ban / rebind). Documented and tested.
- A top-level-in-def nested prompt with `returns` still allows `${r.field}` after `const r = prompt p("a")` (existing happy path).
- `src/transpile/validate-nested-decl.test.ts` covers the chosen rule; `src/runtime/kernel/node-workflow-runtime.nested-decl.test.ts` covers a runtime miss only if you keep in-branch decls.
- `docs/language.md` Nested declarations states where a nested `script`/`def`/`prompt` may appear.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Nested `def` self-recursion matches module-level `def` #dev-ready

Context: A module-level `def fact(n) { … run fact(…) }` validates. A nested `def fact` does not: `validateDefTree` passes `localsSoFar` without the name being defined (`src/transpile/validate.ts` around the nested-def walk). Runtime would work once the `local_decl` has registered `fact` in `scope.locals`.

Problem: nested helpers cannot recurse. Sibling forward-ref (`def a() { run b() }` declared before `def b`) should stay `E_VALIDATE` (sequential, not hoisted). Mutual recursion of two nested defs is out of scope unless it falls out of allowing self.

Remediation — implement exactly this:

1. When validating a nested `def`'s body, include that def's own name in the local map (self only).
2. Do not hoist later siblings.
3. Runtime: a nested `def fact` that calls itself must hit the existing recursion-depth cap (`256`), not a missing-local failure.
4. Docs: one line under Nested declarations — a nested def may call itself; it may not call a nested def declared later.

### Acceptance criteria
- Nested `def fact(n)` that `run fact(…)` on the recursive arm validates; a test fails on today's tree.
- `def a() { run b() }` then `def b()` later in the same def is still `E_VALIDATE` unknown local `b`.
- Runtime: nested `fact` with a base case returns the computed value; a runaway nested recursion hits the existing depth error (not "unknown local").
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Editor plugins: current-surface highlighting leftovers #dev-ready

Context: VS Code TextMate (`plugins/vscode/syntaxes/jaiph.tmLanguage.json`) and Zed/Tree-sitter (`grammars/tree-sitter-jaiph`, `plugins/zed/`) already highlight `use`, named prompt **definitions**, nested `script`/`prompt`, `send … ->`, and stale-keyword regressions. Gaps left after the 0.14.0 review:

1. `#if-statement` in the TextMate grammar only matches a bare `IDENT` subject. Language allows `IDENT.IDENT` (`if answer.risk == "high"`). `answer` / `risk` get no typed-prompt field scopes.
2. Named prompt **invocation** `prompt analyze(log)` is not scoped as `entity.name.function.prompt` on the callee (only the `prompt` keyword).
3. Tree-sitter `grammar.js` still tokenizes `<-` as an `@operator`. The language send form is `->` only; `<-` is `E_PARSE`.
4. Fixtures (`plugins/vscode/test/fixtures/current.jh`, `plugins/zed/test/fixtures/current.jh`) now include a nested `def helper` but have no `export prompt` line and no named-prompt call site.

Remediation — implement exactly this (do not invent a plugin framework):

1. Extend the TM `if` subject to `IDENT` or `IDENT.IDENT` with the same field scopes used for `${var.field}`.
2. Add a TM (and Zed highlight query, if the grammar exposes the node) pattern so `prompt name(` at a call site scopes `name` as a prompt function.
3. Drop `<-` from the tree-sitter operator choice. Regenerated `src/` parser must be committed. Zed query tests must still pass.
4. Add `export prompt` and `const x = prompt analyze(log)` (or `describe`) to both `current.jh` fixtures; assert scopes in `plugins/vscode/test/grammar.test.ts` and the Zed highlight suite.
5. Negative: a fixture line using `<-` must **not** get `keyword.operator.send.jaiph` (VS Code) or a send-operator capture (Zed).

### Acceptance criteria
- `if answer.risk == "ok"` in a VS Code grammar fixture asserts field-access scopes on `answer` / `risk`.
- `const x = prompt analyze(log)` asserts `analyze` has `entity.name.function.prompt.jaiph` (or the Zed equivalent).
- `<-` is not a tree-sitter operator token; `npm test` in `plugins/zed` regenerates and query-checks.
- Stale-keyword regression tests keep passing (`wait` / `local` / `rule` / `workflow` / `ensure` / `inbox`).
- `plugins/vscode`: `npm test`. `plugins/zed`: `npm test`.

## Sweep leftover `workflow` / sandbox wording on live surfaces #dev-ready

Context: The language and runtime no longer have `workflow` / `rule` / `ensure` or a first-party Docker sandbox. User-visible strings and a few tests still teach the old nouns. Historical CHANGELOG entries stay as history.

Live leftovers found in review (re-grep; do not treat this list as exhaustive):

- `src/runtime/kernel/node-workflow-runtime.ts` send-outside-context error: `"workflow execution context"`.
- `src/parse/channels.ts` route error still says `channel <name> -> <workflow>`.
- `src/runtime/kernel/shell-jaiph-guard.ts` diagnostic text still mentions `channel send (<-)`.
- `e2e/tests/30_filesystem_side_effects.sh` "readonly sandbox" branch (`unshare`/`sudo`) is not a Jaiph sandbox and always skips on macOS CI. `docs/contributing.md` still documents `e2e::readonly_sandbox_available`.
- `design/2026-07-14-mcp-server.md` still describes Docker mode / `JAIPH_UNSAFE` (design note; either a one-line "superseded" banner or delete the sandbox claims).
- Test titles in `src/parse/parse-steps.test.ts` (`ensure:` section that tests `run`) and similar.

Remediation — implement exactly this:

1. Change operator-facing error strings to `def` / `send … ->` wording. Keep internal identifiers (`WORKFLOW_RUNNER_ARG`, filenames) unless a rename is a few lines with no behavior change.
2. Remove or rewrite the e2e readonly-sandbox branch so CI does not pretend Jaiph still has a sandbox helper. Update `docs/contributing.md`.
3. Banner or trim the MCP design note so it cannot be read as current sandbox contract.
4. Rename misleading test titles/comments that say `ensure`/`workflow` when they assert `run`/`def`. Do not churn passing assertions.

### Acceptance criteria
- Grep of `src/` `*.ts` (excluding `*.test.ts` comments if you must) for user-facing `"workflow execution"` / `-> <workflow>` / `channel send (<-)` is empty.
- `e2e/tests/30_filesystem_side_effects.sh` no longer documents a Jaiph readonly sandbox; contributing docs match.
- A unit test asserts the send-outside-context (or equivalent) message says `def`, not `workflow`, if that path is reachable; otherwise the string is gone.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.
