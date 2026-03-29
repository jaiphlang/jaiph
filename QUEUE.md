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

## Add workflow-scoped `run async` primitive <!-- dev-ready -->

**Goal**  
Introduce `run async <script_ref> [args...]` as the only supported async orchestration primitive.

**Context**

- Shell-level `&`/`wait` is not the language direction. The runtime centers on Node orchestration; async should be explicit and managed.
- No `run async` support exists anywhere in the codebase currently (confirmed by grep).

**Key files to modify:**
- Parser: `src/parse/steps.ts` — add `run async` step parsing
- AST types: `src/types.ts` — add async flag to run step type
- Validator: `src/transpile/validate.ts` — reject `run async` in rules/scripts/tests
- Runtime: `src/runtime/kernel/node-workflow-runtime.ts` — implement async execution + implicit join
- Progress: `src/cli/run/progress.ts` — render async steps in tree
- Sample: `docs/index.html` and `e2e/async.jh` - rework legacy async samples to match new pattern

**Scope**

1. Grammar + parser:
   - Add `run async ...` in workflow steps only.
   - Reject in rules/scripts/tests with explicit compile-time errors.
2. Runtime semantics:
   - Start async managed step immediately (Promise-based).
   - Implicit join before workflow completes (await all pending async steps).
   - Aggregate failures across async branches.
3. Validation:
   - Reject capture forms like `const x = run async ...` in v1.
4. Coverage:
   - Parser/validator tests.
   - Runtime and e2e fanout/join tests.
   - Multi-failure aggregation test.
5. Remove shell-parallel examples from docs/samples in same change.

**Acceptance criteria**

- `run async ...` works in workflows and joins before completion.
- Invalid forms fail with deterministic, actionable diagnostics.
- Async failures are aggregated and surfaced clearly.
- Docs/examples use `run async` (not shell parallel syntax).

---

## Remove shell redirection syntax and add compiler error (e2e 96) <!-- dev-ready -->

**Goal**  
Remove `e2e/tests/96_run_stdout_redirect.sh` and ensure the compiler rejects shell redirection/pipeline syntax around `run` steps.

**Context**

- Test is skipped at line 13 with `e2e::skip "Shell redirection/pipeline syntax around run steps is not supported in strict script-only Node runtime"`.
- The test covers `run workflow > file &` and `run workflow | pipeline` syntax — both are inherently shell-level constructs that conflict with the Node-first AST-interpreter architecture.
- **Decision**: This is a **non-goal**. Shell redirection around `run` steps will never be supported.

**Key files:**
- `e2e/tests/96_run_stdout_redirect.sh` — delete entirely
- `src/transpile/validate.ts` — add validation rule to reject `>`, `|`, `&` in run/ensure step context
- `src/parse/steps.ts` — potentially reject at parse time

**Scope**

1. Delete `e2e/tests/96_run_stdout_redirect.sh`.
2. Add a compile-time error when the parser/validator detects shell redirection (`>`, `>>`, `|`, `&`) adjacent to `run` or `ensure` step keywords. The error message should be actionable: explain that shell redirection is not supported and suggest using script blocks for shell operations.
3. Add a new e2e test (or section in existing parse-guard test `50_cli_and_parse_guards.sh`) that verifies the compiler error is produced for these forms.
4. Update docs to explicitly state that shell redirection around managed calls is not supported.

**Acceptance criteria**

- `e2e/tests/96_run_stdout_redirect.sh` is deleted.
- Compiler produces clear error for `run foo > file`, `run foo | bar`, `run foo &`.
- New e2e test or test section asserts the compiler error.
- No docs suggest shell redirection around `run`/`ensure` is possible.

---

## Normalize log/logerr display quoting <!-- dev-ready -->

**Goal**  
Remove synthetic outer quotes from rendered `log`/`logerr` messages.

**Context**

- The parser in `src/parse/steps.ts` (lines 149–153) stores the log message **including outer double quotes**: `logArg.slice(0, closeIdx + 1)` where `logArg` starts with `"`. So the AST stores `"message"` not `message`.
- The runtime in `node-workflow-runtime.ts` (line ~461) calls `interpolate(step.message, ...)` which substitutes variables but does NOT strip the outer quotes.
- The display in `src/cli/run/progress.ts` (line ~125) renders `ℹ ${s.message}`, producing `ℹ "message"` in the tree.
- The live TTY display in `src/cli/run/stderr-handler.ts` (line ~208) renders `ℹ safeMessage`.
- The `stripOuterQuotes` function already exists in `node-workflow-runtime.ts` (line ~110) and is used for `return` and `const` — but NOT for `log`/`logerr`.

**Key files:**
- `src/parse/steps.ts` — lines 149–153 (log), 162–166 (logerr): stores message with quotes
- `src/runtime/kernel/node-workflow-runtime.ts` — line ~461 (log interpolation), ~469 (logerr interpolation), ~110 (`stripOuterQuotes` helper)
- `src/cli/run/progress.ts` — lines ~125, ~266 (static tree label rendering)
- `src/cli/run/stderr-handler.ts` — line ~208 (TTY live rendering)

**Fix options** (pick one):
- **Option A (parser)**: Strip quotes at parse time: `logArg.slice(1, closeIdx)` instead of `logArg.slice(0, closeIdx + 1)`. Cleanest — AST stores the actual message.
- **Option B (runtime)**: Apply `stripOuterQuotes` before `interpolate` in the log/logerr handler.

**Scope**

1. Fix the quoting at the chosen layer (parser preferred).
2. Preserve inner quotes and multiline formatting.
3. Update affected e2e tests that assert tree output containing log messages (search for `ℹ` and `!` in `e2e/tests/*.sh`).
4. Update display tests in `src/cli/run/display.test.ts` if needed.

**Acceptance criteria**

- Standard `log "Hello $name"` output shows `ℹ Hello world` not `ℹ "Hello world"`.
- Escaping and multiline behavior remain correct.
- All e2e and unit tests pass.

---

## Align interpolation with JS string semantics <!-- dev-ready -->

**Goal**  
Adopt JavaScript template literal semantics as the single interpolation model. Eliminate conflicting language direction around backticks and shell-style expansion.

**Context**

- **Decision**: Jaiph strings follow JS string rules. `"something ${var}"` is the canonical interpolation form. Backticks that appear literally must be escaped. `${var:-fallback}` is shell syntax and should NOT be supported.
- Previous queue had contradictory tasks: "reject backticks" and "allow backticks in prompt strings".
- Current interpolation implementation in `node-workflow-runtime.ts` (line ~69) handles `${varName}` and `$varName` patterns but uses shell-style regex matching.
- Substitution validation in `src/transpile/validate-substitution.ts` validates `$(...)` command substitutions.
- No explicit backtick policy exists in the parser or validator.

**Key files:**
- `src/runtime/kernel/node-workflow-runtime.ts` — `interpolate()` function (line ~69)
- `src/transpile/validate-substitution.ts` — command substitution validation
- `src/transpile/validate.ts` — main validation logic
- `src/parse/steps.ts` — step parsing (string handling)
- `src/parse/core.ts` — core parsing primitives
- `docs/grammar.md` — grammar documentation

**Scope**

1. Define the explicit interpolation rule set:
   - `${varName}` — supported (JS template literal style).
   - `$varName` — supported (convenience shorthand, like shell).
   - `${var:-fallback}` — **rejected** with compile-time error ("shell fallback syntax not supported; use conditional logic").
   - Backtick characters — **must be escaped** (`\``) in all string contexts. Unescaped backticks produce a compile-time error.
   - `$(...)` — **rejected** in orchestration contexts (already enforced), allowed in script bodies.
2. Update parser/validator to enforce these rules.
3. Add focused positive/negative tests:
   - Valid: `"hello ${name}"`, `"value is $x"`, `"escaped backtick: \`cmd\`"`
   - Invalid: `"${var:-default}"`, unescaped backtick in string, `"$(command)"` in workflow context.
4. Update `docs/grammar.md` and any other docs that discuss string interpolation.

**Acceptance criteria**

- Backtick and `${...}` behavior is fully deterministic and documented.
- `${var:-fallback}` is rejected with actionable error.
- Unescaped backticks are rejected with actionable error.
- No contradictory docs/tests remain.
- Grammar docs explicitly state "JS template literal semantics."

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

**Acceptance criteria**

- Prompt lines include backend/model in live output.
- Display is readable and consistent in TTY/non-TTY.

---

## Inline construct interpolation `${run ...}` / `${ensure ...}` <!-- dev-ready -->

**Goal**  
Allow inline managed captures in interpolation expressions.

**Context**

- Current pattern requires temporary vars for one-time values:
  ```
  const result = run some_script
  log "Got: $result"
  ```
- With inline interpolation:
  ```
  log "Got: ${run some_script}"
  ```
- The `interpolate()` function in `node-workflow-runtime.ts` (line ~69) currently only handles `${varName}` and `$varName` — no `${run ...}` or `${ensure ...}`.

**Key files:**
- `src/runtime/kernel/node-workflow-runtime.ts` — `interpolate()` (line ~69), must be extended
- `src/parse/steps.ts` — string parsing, detect `${run ...}` / `${ensure ...}` forms
- `src/transpile/validate.ts` — validate refs inside inline captures
- `src/types.ts` — possibly extend AST step types for inline captures

**Scope**

1. Add parser support for `${run ...}` and `${ensure ...}` inside string interpolation.
2. Validate refs with same rules as standalone steps.
3. Implement runtime interpolation behavior: execute the managed call, capture output, inline it.
4. Reject nested inline managed captures (`${run "${run ...}"}`).
5. Add tests and doc updates.

**Acceptance criteria**

- Inline run/ensure interpolation works and failure propagates correctly.
- Invalid forms fail with clear diagnostics.

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
  workflow default { run do_thing }
  ```
- With inline scripts:
  ```
  workflow default { script "echo done" }
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
