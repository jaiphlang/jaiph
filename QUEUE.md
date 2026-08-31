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

## Nested script, named prompt, const, and def inside defs #dev-ready

Context: Top-level modules already hold `const`, `script`, `def`, and (after named prompts exist) `prompt` in one namespace. A def body already allows `const` as a **step** (`const_decl_step`). It does not allow nested `script`, named `prompt`, or `def`. Scripts and named prompts therefore cannot be scoped to the def that uses them; everything lives at module scope.

Problem: Modern languages allow local functions. Jaiph forces every helper script/def/prompt to pollute the module namespace. Nested definitions are sequential local bindings: simple, and they let a def close over its parameters in nested **interpreted** forms (`def`, named `prompt` bodies) without adding call-site `use`.

Remediation — implement exactly this:

1. **A def body may declare** nested `const` (already), `script`, named `prompt`, and `def`. Same surface as module-level for each (including `use` on nested `script` / named `prompt`, params on nested `def` / named `prompt`). **No `export` on nested declarations** (`E_PARSE`). **No nested `config` / `import` / `channel`.**

2. **Sequential local scope, not hoist.** A nested name is visible only in the enclosing def, and only **after** its declaration (same as today’s `const` steps). Using it above the declaration is `E_VALIDATE` (unknown / not in scope). Nested names share one local namespace with the def’s parameters and `const` bindings: duplicates are `E_PARSE` (same unified-namespace rule, but per def). A nested name **may shadow** a module-level `script` / `def` / `prompt` / `const` of the same name; the local binding wins for the rest of the body. Nested declarations do not shadow the enclosing def’s parameters (`E_PARSE` / existing immutable-binding rule — same as `const` vs param).

3. **Call rules (unchanged verbs):**
   - nested script → `run name(args)`
   - nested def → `run name(args)` (and `run async` allowed, same as top-level defs)
   - nested named prompt → `prompt name(args)` with parentheses
   Outer module code and other defs **cannot** `run` / `prompt` another def’s nested names (`E_VALIDATE`).

4. **Closure vs subprocess:**
   - Nested **def**: interpreted in-process. Its body interpolates the enclosing def’s params and consts (lexical scope) plus its own params. It does **not** inherit a parent `use` (defs still have no `use`). Child def’s nested scripts/prompts use their own `use` only.
   - Nested **named prompt**: body interpolated at **invocation** from the enclosing scope (params/consts visible), plus its own parameters. `use` on that nested prompt is the only extra host-key injection for that agent spawn.
   - Nested **script**: still a subprocess. Enclosing bindings are **not** auto-exported into its env. Pass argv (`run inner(param)` → `$1`). Sterile env + its own `use` + `--env` grant (same as module-level scripts).

5. **Emit.** Nested scripts are emitted as script files with stable unique names (hash or enclosing-def-qualified), same interpreter/shebang path as top-level scripts. Do not require the OS exec bit.

6. **If named prompts are not in the tree yet**, nested `prompt name(params) = …` is still required by this task — implement the named-prompt definition/call forms at least for the nested case (module-level named prompts may land in the same change if cheaper than two parsers). If they already exist, reuse the same productions inside `def_step`.

7. **Docs:** `docs/grammar.md` (`def_step` includes the nested decls), `docs/language.md`, `docs/jaiph-skill.md`. State: not hoisted; no export; scripts do not close over; defs/prompts interpolate enclosing scope at runtime.

### Acceptance criteria
- Parse a def that contains a nested `script`, nested `def`, nested named `prompt`, and `const`, then `run` / `prompt` them later in the same body; `jaiph format` round-trips.
- `export script` / `export def` / `export prompt` inside a def is `E_PARSE`.
- Nested name used before its declaration is `E_VALIDATE`. Nested name colliding with a parameter is rejected. Nested `script foo` shadows module-level `script foo` for `run foo()` after the nested declaration; a unit/e2e test shows the nested body ran, not the module one.
- A nested def interpolates an enclosing parameter in a `log` / `return` without that param being passed as an argument to the nested def.
- A nested script whose body prints `"$1"` does **not** see the enclosing param unless it was passed as `run nested(param)`; a test fails if the child env or stdout contains the enclosing param with no argv pass.
- Another def in the same file cannot `run nested_helper()` when `nested_helper` is declared only inside `outer` (`E_VALIDATE`).
- Nested script `use GITHUB_TOKEN` participates in `--env` preflight the same way as a module-level `use` (fail `jaiph run` without the flag).
- `npm run build`, `npm test`, and `npm run test:e2e` pass.
