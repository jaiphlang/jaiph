# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   - breaking changes are allowed,
   - backward compatibility is **not** a design goal unless a task explicitly says otherwise.

---

## Pattern matching on strings (Rust-style `match`) <!-- dev-ready -->

**Goal**  
Add `match` on string values with **string literals** and **JavaScript regex literals** as patterns, Rust-like syntax: `match <expr> { <pattern> => <body>, ... }`.

**Context**

- Only two pattern kinds: **string literals** and **regex literals** (e.g. `/[a-z]+/` — same as JS regex).
- **Exhaustiveness:** every `match` must include exactly **one** default arm using `_` (wildcard). Duplicate `_` arms are a compile-time error.
- **Evaluation order:** arms are processed **top to bottom**; the **first** matching arm runs and **only that arm** applies (no fall-through to later arms).
- No other pattern kinds (no numbers, destructuring, etc.) in this task.
- **Expression form:** `match` must be a valid **expression**, not only a standalone statement, so the value of the chosen arm is the value of the whole `match` — e.g. `return x match { ... }` (subject `x`, then `match { ... }` as the return value).
- **Mocks:** **Hard-remove** the `contains` keyword from `mock prompt { }` (no deprecation window). Prompt dispatch in `*.test.jh` should use the same **pattern matching** model (literals + regex + `_`) as workflows — no parallel substring / `contains` mini-language.

**Key files:**
- `src/parse/*` — new statement/expression form for `match`
- `src/types.ts` — AST for match arms
- `src/runtime/kernel/node-workflow-runtime.ts` — evaluate subject, test patterns top-to-bottom, run selected arm only
- `src/transpile/validate.ts` — ensure exactly one `_`; validate regex literals
- `src/parse/tests.ts`, `src/runtime/kernel/node-test-runner.ts` — delete `contains`-based mock prompt parsing/generation; replace with `match`-driven mock dispatch
- `docs/testing.md`, `docs/index.html` — mock prompt docs after migration

**Scope**

1. Parse `match x { "lit" => ..., /re/ => ..., _ => ... }`.
2. Validate: exactly one `_` arm; reject `match` with zero or multiple `_` at compile time.
3. Runtime: string equality for literal arms; `RegExp` test for regex arms; evaluate arms in source order, first match wins, no further arms run.
4. Implement **`match` as an expression**: each arm body produces a value; the `match` expression evaluates to the selected arm’s value (so `return x match { ... }` and assigning `y = z match { ... }` work).
5. **Mocks:** remove `if ${arg1} contains` / `elif ... contains` / `respond` (or equivalent) entirely; re-express `mock prompt { ... }` using pattern `match` on the prompt text (same pattern rules as workflow `match`), updating parser, generated dispatch, fixtures, and docs.
6. Tests: literals, regex, default arm, missing `_` / duplicate `_` rejected at compile time; returnable `match`; migrated mock tests with no `contains`.
7. Docs: grammar + examples (ordering semantics, expression form, mock prompt shape).

**Acceptance criteria**

- Valid `match` runs with correct branch selection; only one arm executes.
- Missing `_` or more than one `_` is a compile-time error.
- Only string and `/.../` regex patterns allowed; invalid forms have clear errors.
- **`return x match { ... }`** (and other expression positions) type-check / parse and return the matched arm’s value.
- **`contains` does not appear** in mock prompt syntax or test parser; prompt mocks use pattern `match` only.

---

## Unify string quoting across Jaiph <!-- dev-ready -->

**Goal**  
**Policy is fixed:** Jaiph string literals use **double quotes only** (`"..."`). **No** single-quoted string literals (`'...'`) and **no** backtick-delimited string literals (`` `...` ``) anywhere in Jaiph surface syntax. One rule for orchestration strings, `fail` / `log` / `logerr`, `mock prompt`, `const` / `local` RHS, test blocks, metadata, etc.

**Context**

- **Hard rewrite:** This is an intentional **breaking change**. **No backward compatibility** — existing `.jh` / tests / docs that use `'...'` or `` `...` `` as Jaiph string delimiters must be migrated wholesale (mechanical find/replace is not always enough; escaping inside `"` must be correct).
- Today behavior is **inconsistent** (e.g. `fail` vs `mock prompt`); this task **removes** alternate quote forms instead of unifying semantics across them.
- **Exception (unchanged):** `script { ... }` bodies remain **opaque shell**; authors may still use normal shell quoting (single quotes, command substitution, etc.) **inside** the script text. The policy applies to **Jaiph** tokens, not to arbitrary characters inside opaque script bodies.
- Escaping: document how `"` and newlines appear inside `"..."` (e.g. `\"`); interpolation rules for `${...}` stay as today inside double-quoted strings.

**Key files:**  
`src/parse/*`, `docs/grammar.md`, user-facing docs, fixtures, e2e, `.jaiph/*.jh` and examples.

**Scope**

1. Document the policy in grammar (and a short note on script-body exception).
2. Remove single-quoted and backtick string forms from all Jaiph parsers; align validators and error messages (“use `\"...\"` only”).
3. Migrate repo sources, tests, and docs; **no** compatibility shims or deprecation period unless this task is explicitly split.

**Acceptance criteria**

- Only `"..."` is accepted for Jaiph string literals in every covered construct; `'` / `` ` `` as delimiters are **parse errors** with clear fixes.
- Script opaque bodies are explicitly out of scope for quoting rules (documented).
- **No backward compat:** old forms do not parse; migration path is “rewrite sources to `"` + escapes.”

---

## Bare identifiers as `run` / `ensure` arguments <!-- dev-ready -->

**Goal**  
Allow capture variables and other in-scope names as **bare identifiers** in `run` / `ensure` argument lists, equivalent to passing their string values without wrapping in a quoted orchestration string.

**Context**

- Today, passing a value from a prior step often requires a quoted interpolation:
  ```
  run docs.update_from_task("${task}")
  run queue.remove_completed_task("${task_header}")
  run git.commit("${task}")
  ```
- Authors want the same semantics with less noise:
  ```
  run docs.update_from_task(task)
  run queue.remove_completed_task(task_header)
  run git.commit(task)
  ```
- This is distinct from full expression syntax; scope is **identifier → string coercion** for managed-call args only (exact resolution rules TBD: captures vs workspace symbols).

**Key files**

- `src/parse/*` — `run` / `ensure` argument parsing (extend atom forms beyond string literals)
- `src/transpile/validate.ts` — ref/identifier resolution for new forms
- `src/runtime/kernel/node-workflow-runtime.ts` — if argument normalization happens at runtime
- `docs/grammar.md` — document allowed bare identifiers and equivalence to `"${name}"`

**Scope**

1. Parse bare identifiers in `run` / `ensure` argument positions where strings are currently allowed.
2. Define and validate which identifiers are permitted (e.g. `const` / step captures in scope; reject unknown names with clear errors).
3. Implement behavior equivalent to the corresponding `"${identifier}"` orchestration string for the same binding.
4. Add parser, validator, and e2e coverage; keep existing quoted forms working unchanged.

**Acceptance criteria**

- Forms like `run git.commit(task)` work when `task` is an in-scope capture with the expected string value.
- Invalid or ambiguous identifiers fail at compile/validation with actionable errors.
- Documented equivalence: bare `name` vs `"${name}"` where both are supported.

## Add Codex backend support <!-- dev-ready -->

**Goal**  
Support `codex` as a first-class prompt backend via the OpenAI Codex API.

**Context**

- Current runtime supports `cursor` and `claude` backend paths. Backend selection happens via `agent.backend` config.
- Prompt execution lives in `src/runtime/kernel/prompt.ts`.
- Backend config resolution uses `resolveConfig` in the runtime.
- The Codex backend should use the OpenAI Codex API (default endpoint). Agent should discover the current API surface and implement accordingly.

**Key files:**
- `src/runtime/kernel/prompt.ts` — prompt execution, backend dispatch
- `src/runtime/kernel/node-workflow-runtime.ts` — `resolveConfig`, prompt step handling
- `src/types.ts` — config types, backend enum
- `docs/configuration.md` — backend configuration docs

**Scope**

1. Add backend config validation for `codex`.
2. Implement runtime adapter for prompt + schema-return flows using the OpenAI Codex API.
3. Match existing streaming/error/logging contract used by cursor/claude backends.
4. Add tests (unit + integration with mocks).
5. Update docs with setup + minimal example.

**Acceptance criteria**

- `agent.backend = "codex"` routes prompt execution correctly.
- Missing config (API key, etc.) fails with actionable errors.
- Structured `returns` works with codex.

---
