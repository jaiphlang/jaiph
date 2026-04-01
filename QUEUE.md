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
