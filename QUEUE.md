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

## Add `jaiph build` command (standalone binary) <!-- dev-ready -->

**Goal**  
Add a `jaiph build [file|path]` CLI command that builds a standalone Bun executable from a `.jh` project.

**Context**

- `npm run build:standalone` in `package.json` already works: it runs `tsc`, copies runtime assets, then `bun build --compile ./src/cli.ts --outfile ./dist/jaiph`.
- The user-facing command set is `run`, `test`, `init`, `use`, `report` — `build` is not yet exposed as a CLI subcommand.
- The old `jaiph build` (transpile `.jh` → `.sh`) was removed from user-facing CLI. The new `jaiph build` is a different command — it builds a standalone distributable binary.
- CLI commands live in `src/cli/commands/` — existing: `run.ts`, `test.ts`, `init.ts`, `use.ts`, `report.ts`.
- CLI usage/help is in `src/cli/shared/usage.ts`.

**Key files:**
- `src/cli/commands/` — add `build.ts`
- `src/cli/shared/usage.ts` — add `build` to help output
- `src/cli.ts` (or wherever CLI dispatch lives) — add `build` subcommand dispatch
- `package.json` — reference existing `build:standalone` script logic

**Scope**

1. Add `build` subcommand (`src/cli/commands/build.ts`) and CLI dispatch.
2. Default behavior: `jaiph build` (no args) builds from current directory (`./`).
3. Accept optional `[file|path]` argument to specify input.
4. Under the hood: reuse the existing standalone build logic (tsc + copy assets + bun compile).
5. Update `src/cli/shared/usage.ts` with the new command.
6. Add an e2e test that runs `jaiph build`, verifies the output binary exists and is executable.

**Acceptance criteria**

- `jaiph build` produces a standalone binary.
- `jaiph build path/to/project` works.
- Binary runs without Node installed.
- e2e test covers the build command and verifies the output binary.
- `jaiph --help` lists the `build` command.

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

## Unified mock syntax: rename `mock function` to `mock script` <!-- dev-ready -->

**Goal**  
Hard-rename `mock function` to `mock script` across parser, AST, runtime, tests, and docs.

**Context**

- The top-level keyword was already renamed from `function` to `script` in the language, but the mock keyword in `*.test.jh` files was not updated.
- **Decision**: Hard rework. `mock function` must produce a **compiler error**, not a silent migration.

**Current code using `mock function`:**
- `src/types.ts` (line ~249): AST type `test_mock_function` — rename to `test_mock_script`.
- `src/parse/tests.ts` (line ~221): regex `mock\s+function\s+...` — change to `mock\s+script\s+...`.
- `src/parse/tests.ts` (line ~225): error message `"mock function ref must be..."` — update.
- `src/parse/tests.ts` (line ~228): pushes `{ type: "test_mock_function" }` — rename type.
- `src/runtime/kernel/node-test-runner.ts` — dispatches on `test_mock_function` type.
- `test/sample-build.test.ts` — fixture tests using `mock function`.
- `e2e/tests/45_mock_workflow_rule_function.sh` — e2e test using `mock function` syntax.
- `docs/testing.md` — docs showing `mock function`.
- `docs/index.html` — mentions `mock function`.

**Scope**

1. Rename `test_mock_function` → `test_mock_script` in `src/types.ts`.
2. Change parser regex from `mock\s+function` to `mock\s+script` in `src/parse/tests.ts`.
3. Add explicit rejection: if the parser sees `mock function`, emit a compile-time error: `"mock function" is no longer supported; use "mock script"`.
4. Update dispatch in `src/runtime/kernel/node-test-runner.ts`.
5. Update all test fixtures: `e2e/tests/45_mock_workflow_rule_function.sh`, `test/sample-build.test.ts`, and any `.test.jh` fixtures.
6. Rename `e2e/tests/45_mock_workflow_rule_function.sh` → `45_mock_workflow_rule_script.sh`.
7. Update docs: `docs/testing.md`, `docs/index.html`.

**Acceptance criteria**

- `mock script` parses and executes correctly.
- `mock function` produces a compiler error with migration guidance.
- All tests pass with the new syntax.
- No references to `mock function` remain (except in error message text).

---

## Named parameters for workflows/rules/scripts <!-- dev-ready -->

**Goal**  
Replace positional parameter ergonomics with named declaration parameters.

**Context**

- Existing `$1`, `$2` style is error-prone and unreadable in larger flows.
- Named params would look like:
  ```
  workflow greet(name, greeting = "hello") {
    log "$greeting $name"
  }
  ```

**Key files:**
- `src/parse/workflows.ts` — workflow parsing (add param list)
- `src/parse/rules.ts` — rule parsing (add param list)
- `src/parse/scripts.ts` — script parsing (add param list)
- `src/types.ts` — AST types (add `params` field to workflow/rule/script defs)
- `src/runtime/kernel/node-workflow-runtime.ts` — materialize params as locals
- `src/transpile/validate.ts` — arity validation at call sites

**Scope**

1. Add `params` to AST for workflows/rules/scripts.
2. Parse declaration params with optional defaults.
3. Materialize params as locals/variables in runtime path.
4. Enforce arity validation at call sites.
5. Migrate internal `.jh` sources and fixtures.
6. Update tests + docs.

**Acceptance criteria**

- Declared params are available by name in bodies.
- Missing required args fail fast with deterministic errors.
- Migration completes across internal/e2e fixtures.

---

## Dot notation for typed prompt fields `${var.field}` <!-- dev-ready -->

**Goal**  
Support field access syntax for typed prompt captures.

**Context**

- Underscore-concatenated names (`$response_message`) are ambiguous and non-obvious.
- The `interpolate()` function in `node-workflow-runtime.ts` (line ~69) currently matches `${identifier}` and `$identifier` — no dot notation.

**Key files:**
- `src/runtime/kernel/node-workflow-runtime.ts` — `interpolate()` (line ~69)
- `src/parse/steps.ts` — string parsing
- `src/transpile/validate.ts` — validation (check field against prompt schema)

**Scope**

1. Parse `${identifier.field}` in interpolation.
2. Validate `field` against prompt schema for `identifier`.
3. Implement deterministic runtime mapping to existing storage format.
4. Update docs and tests.

**Acceptance criteria**

- `${response.message}` works in all interpolation contexts.
- Invalid field names fail at validation time with actionable errors.

---

## Anonymous inline scripts in workflows/rules <!-- dev-ready -->

**Goal**  
Allow `script "..."` inline steps for trivial commands.

**Context**

- Named scripts are verbose for one-off operations:
  ```
  script do_thing() { echo "done" }
  workflow default() { run do_thing }
  ```
- With inline scripts:
  ```
  workflow default() { script "echo done" }
  ```

**Key files:**
- `src/parse/steps.ts` — add inline script step parsing
- `src/types.ts` — add inline script step AST type
- `src/runtime/kernel/node-workflow-runtime.ts` — execute inline script
- `src/transpile/build.ts` — generate deterministic script artifacts

**Scope**

1. Add AST/parser step for inline script body.
2. Generate deterministic script artifact names.
3. Support capture form (`const x = script "..."`).
4. Preserve shebang behavior for custom interpreters.
5. Add tests (unit + e2e).

**Acceptance criteria**

- Inline script steps execute with same isolation contract as named scripts.
- Generated script artifacts are deterministic.
