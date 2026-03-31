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

## Direct `return run` / `return ensure` support <!-- dev-ready -->

**Goal**  
Allow `return run ...` and `return ensure ...` directly in workflows/rules.

**Context**

- Current syntax requires boilerplate capture then return:
  ```
  const result = run some_script
  return "$result"
  ```
- With direct return:
  ```
  return run some_script
  ```

**Key files:**
- `src/parse/steps.ts` — return step parsing
- `src/types.ts` — return step AST type (extend for managed call)
- `src/runtime/kernel/node-workflow-runtime.ts` — return step execution (~line 490)
- `src/transpile/validate.ts` — validate refs in return expressions

**Scope**

1. Extend parser/AST return expression forms to accept `run` and `ensure` as return value sources.
2. Reuse managed-call validation for ref resolution.
3. Implement runtime behavior equivalent to capture + return.
4. Add unit/acceptance/e2e tests.

**Acceptance criteria**

- Direct return forms execute correctly.
- Unknown ref errors remain deterministic.

---

## Show prompt backend/model in run tree <!-- dev-ready -->

**Goal**  
Render prompt backend/model inline in tree output (`prompt <backend> "<preview>"`).

**Context**

- Mixed-backend runs are hard to debug from live tree alone.
- Prompt step start is emitted in `node-workflow-runtime.ts` via `emitPromptStepStart` (~line 291) which already has access to `backend` and the prompt text.
- The tree label is constructed in `src/cli/run/progress.ts` via `formatPromptLabel` (line ~122).
- Live TTY rendering is in `src/cli/run/stderr-handler.ts`.
- Non-TTY rendering is also in progress/display paths.

**Key files:**
- `src/cli/run/progress.ts` — `formatPromptLabel`, prompt step rendering (line ~122)
- `src/cli/run/stderr-handler.ts` — live TTY prompt display
- `src/runtime/kernel/node-workflow-runtime.ts` — `emitPromptStepStart` (~line 291), prompt event emission
- `src/cli/run/events.ts` — event parsing

**Scope**

1. Extend prompt step rendering to include backend/model: `prompt cursor/gpt-5 "summarize the..."` format.
2. Pass backend/model info through the event pipeline (if not already in `PROMPT_START` event payload).
3. Apply the same format in both TTY and non-TTY modes.
4. Add tests in CLI display/event parsing paths.
5. Update docs/examples to match exact rendered format.
6. Update sample outputs in `docs/index.html`

**Acceptance criteria**

- Prompt lines include backend/model in live output.
- Display is readable and consistent in TTY/non-TTY.

---

## Auto-detect model for selected backend <!-- dev-ready -->

**Goal**  
Auto-select a usable model when explicit model is missing/unavailable.

**Context**

- Hard failures on unavailable model names reduce usability and increase support burden.
- Model selection currently happens in `src/runtime/kernel/prompt.ts` and config resolution.

**Key files:**
- `src/runtime/kernel/prompt.ts` — prompt execution, model selection
- `src/runtime/kernel/node-workflow-runtime.ts` — config resolution
- `docs/configuration.md` — model configuration docs

**Scope**

1. Implement provider-specific model discovery policy.
2. Selection order:
   - explicit and available → use,
   - explicit but unavailable → fallback by policy,
   - missing → choose default compatible model.
3. Emit diagnostics showing selected model and why.
4. Add tests for all selection paths.
5. Update docs with override + fallback behavior.

**Acceptance criteria**

- Run/test succeeds without explicit model when compatible model exists.
- Selection/fallback decisions are visible in diagnostics.
- No-compatible-model path is actionable.

---

## Reporting: detect SIGKILL-stalled runs <!-- dev-ready -->

**Goal**  
Mark runs as terminated when `WORKFLOW_END` never arrives due to hard kill.

**Context**

- Reporting server can leave killed runs in active state forever.
- Reporting code lives in `src/reporting/*`.
- Run state is tracked via `run_summary.jsonl` and `.jaiph/runs/` artifacts.

**Key files:**
- `src/reporting/` — reporting server and state management
- `src/runtime/kernel/emit.ts` — event emission (WORKFLOW_START/END)

**Scope**

1. Implement stale run detection using timeout + liveness signal.
2. Mark stale entries as terminated/failed in API/UI.
3. Add integration/e2e test: start run, SIGKILL, verify terminal state.

**Acceptance criteria**

- SIGKILL run transitions to terminal state automatically.
- Normal completed runs unaffected.

---

## Add `jaiph format` command <!-- dev-ready -->

**Goal**  
Add an opinionated formatter for `.jh` files with in-place and check modes.

**Context**

- No built-in formatting command exists; style drifts and noisy diffs are common.
- CLI commands live in `src/cli/commands/`.
- The parser (`src/parser.ts`, `src/parse/*`) already produces a full AST that can be re-emitted.

**Key files:**
- `src/cli/commands/` — add `format.ts`
- `src/cli/shared/usage.ts` — add `format` to help output
- `src/parser.ts`, `src/parse/*` — parser used for formatting input
- `src/types.ts` — AST types for re-emission

**Scope**

1. Add `format` subcommand (`src/cli/commands/format.ts`) and CLI dispatch.
2. Parse → re-emit stable source formatting from AST.
3. Support:
   - `--indent <n>` (default `2`),
   - `--check` (non-zero when changes needed).
4. Preserve comments and fail fast on parse errors.
5. Add unit + e2e coverage.

**Acceptance criteria**

- `jaiph format file.jh` rewrites in place.
- `jaiph format --check` is CI-safe.
- Formatting is idempotent.

---

## Anonymous inline scripts in workflows/rules <!-- dev-ready -->

**Goal**  
Allow `script "..."` inline steps for trivial commands.

**Context**

- Named scripts are verbose for one-off operations:
  ```
  script do_thing { echo "done" }
  workflow default { run do_thing() }
  ```
- With inline scripts:
  ```
  workflow default { run script("echo $1", "arg1", "arg2) }
  ```

**Key files:**
- `src/parse/steps.ts` — add inline script step parsing
- `src/types.ts` — add inline script step AST type
- `src/runtime/kernel/node-workflow-runtime.ts` — execute inline script
- `src/transpile/build.ts` — generate deterministic script artifacts

**Scope**

1. Add AST/parser step for inline script body.
2. Generate deterministic script artifact names.
3. Support capture form (`const x = run script "..."`).
4. Preserve shebang behavior for custom interpreters.
5. Add tests (unit + e2e).

**Acceptance criteria**

- Inline script steps execute with same isolation contract as named scripts.
- Generated script artifacts are deterministic.

---

## `script:node` / `script:python3` / … — interpreter syntax sugar <!-- dev-ready -->

**Goal**  
Allow optional `script:<tag>` forms that expand to a fixed shebang (e.g. `#!/usr/bin/env node`) so authors do not hand-write shebang lines for common interpreters.

**Context**

- Custom shebang in script bodies remains supported for arbitrary tooling.
- Sugar examples: `script:node name { ... }`, `script:python3 name { ... }` → appropriate `#!/usr/bin/env <runtime>` (exact mapping documented and tested).
- Lays groundwork for future first-class tags such as PowerShell (`script:pwsh` or similar) and Windows-friendly workflows.

**Key files:**
- `src/parse/scripts.ts` — parse `script:<identifier>` prefix before script name
- `src/transpile/build.ts` — emit generated script with implied shebang when tag present
- `src/types.ts` — AST: store interpreter tag on script def if needed
- `docs/` — document supported tags and escape hatch (raw shebang)

**Scope**

1. Define grammar: `script:<tag> <name> { ... }` alongside plain `script <name> { ... }`.
2. Maintain a small built-in map tag → shebang line (node, python3, …); reject unknown tags with a clear error or document extension point.
3. Tests: parse, emitted artifact shebang, execution smoke for at least node + one other.
4. Update docs and any samples that currently use manual shebang for those interpreters.

**Acceptance criteria**

- `script:node` (and agreed set of tags) produces correct shebang in generated artifacts.
- Plain `script` + manual shebang behavior unchanged.
- Unknown `script:foo` fails with an actionable diagnostic (or is explicitly extensible per product choice).

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
