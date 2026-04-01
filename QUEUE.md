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
