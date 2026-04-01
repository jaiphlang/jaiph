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
