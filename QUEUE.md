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

## Remove bash workflow modules — Node-only orchestration <!-- dev-ready -->

**Goal**  
Eliminate **workflow-level** bash emission entirely. The only shell artifacts should be **atomic `script` step** executables under `scripts/` (plus whatever tiny helpers remain, if any). **`jaiph run`** (including Docker) should use the **same** `NodeWorkflowRuntime` / `node-workflow-runner` path as local runs.

**Context**

- Today **`transpileFile()`** (via `emitWorkflow`) still produces a **full module bash string** (`EmittedModule.module`) and **`build()`** in `src/transpile/build.ts` writes that to **`.sh` files** mirroring the `.jh` tree (`writeFileSync(outPath, module, ...)`).
- **`buildScripts()`** already skips module `.sh` and only writes **per-step script files** — that is the intended product direction.
- **Docker `jaiph run`** (`src/cli/commands/run.ts`, `src/runtime/docker.ts`) uses **`build()`** and mounted **`jaiph_stdlib.sh`** so the container **executes the generated module `.sh`** as the workflow orchestrator — a **second orchestration implementation** beside the Node AST interpreter.
- That split is what earlier reviews called **“Node AST vs emitted bash”**: the **bash** is the **`module` string** from **`emit-workflow.ts`** (workflow rules, `run`, `if`, prompts-as-shell, etc.), not the small extracted **script** bodies.

**This task subsumes (directionally)** the earlier architecture notes on: (1) one validated AST/graph story across tools, (3) unifying Docker with Node semantics, (4) a single prepare→launch abstraction — once bash workflows are gone, Docker is “run the same runner in the container” instead of a parallel shell stack.

**Key files**

- `src/transpile/build.ts` — `build()` vs `buildScripts()`
- `src/transpiler.ts` — `transpileFile()`, `build()` export
- `src/transpile/emit-workflow.ts` — module `.sh` emission source
- `src/cli/commands/run.ts` — Docker vs non-Docker prep and spawn
- `src/runtime/docker.ts` — container command line, mounts, generated layout
- `src/jaiph_stdlib.sh` — only needed if module `.sh` orchestration remains; scope removal or shrinking with this task
- `src/transpile/compiler-golden.test.ts` and any fixtures asserting on generated **workflow** `.sh`
- `ARCHITECTURE.md` — diagrams and Docker wording

**Scope**

1. **Docker**: change container entry to **`node-workflow-runner`** (or equivalent single binary + args), with the same env/meta contract as local `jaiph run`. Mount/copy **kernel + dist** (or compile a runner-only image) so no **workflow** `.sh` is required. Keep workspace mount semantics.
2. **Remove product use of `build()`** for workflow modules: CLI paths should use **`buildScripts()`**-class output only; delete or gate **`build()`**’s module `.sh` writes behind tests if still needed briefly for golden diffs.
3. **Transpiler**: stop producing **`EmittedModule.module`** for production code paths, or reduce `emitWorkflow` so validation + script extraction do not depend on synthesizing a full bash workflow (refactor `transpileFile` accordingly; golden tests migrate to scripts-only or Node-level expectations).
4. **Cleanup**: remove dead bash runtime paths, update e2e/docker tests, and document the single orchestration model.

**Acceptance criteria**

- No **workflow** `.sh` files are written for **`jaiph run`** / **`jaiph test`** / Docker in normal operation.
- Docker runs behave as **Node-orchestrated** workflows with the same semantics as local (modulo intentional isolation); `jaiph_stdlib.sh` is not required for **workflow** control flow.
- Tests and docs reflect **scripts-only** artifacts + Node runtime only.

---

## Cache `buildRuntimeGraph` in `jaiph test` <!-- dev-ready -->

**Goal**  
Avoid repeated **`buildRuntimeGraph(testFileAbs)`** work when a single test file runs **multiple** `test_run_workflow` steps.

**Context**

- `src/runtime/kernel/node-test-runner.ts` builds the graph **inside** the loop over steps, for each **`test_run_workflow`** (`buildRuntimeGraph(testFileAbs)` per step).
- The graph for a given test file is identical across those steps in a block; only **`mockBodies`** / env differ.

**Key files**

- `src/runtime/kernel/node-test-runner.ts` — `runTestBlock`, `runTestFile`

**Scope**

1. Build **`RuntimeGraph` once per test block** (or once per `runTestFile` if safe across blocks) and reuse for every **`test_run_workflow`** in that scope.
2. Confirm invalidation rules if future steps mutate imports on disk (document “same process, same file” assumption).
3. Add a small unit test or timing assertion that multiple workflow steps do not re-parse the full import closure (cache hit), if easy.

**Acceptance criteria**

- Multiple **`test_run_workflow`** steps in one block share one graph build unless a documented edge case requires refresh.
- Behavior and fail semantics unchanged.

---

## Strict live events on stderr (__JAIPH_EVENT__) <!-- dev-ready -->

**Goal**  
Make **`__JAIPH_EVENT__`** JSONL appear on **stderr only** for all **`jaiph run`** modes, so the CLI does not need **dual stdout/stderr** parsing.

**Context**

- Default local runs already stream events on **stderr**.
- **`jaiph run` with Docker** (`src/cli/commands/run.ts`) parses **both** stdout and stderr for step/log events because the **bash** workflow in the container may interleave streams differently.

**Key files**

- `src/cli/commands/run.ts` — `wireStreams`, `drainBuffers`, Docker branch
- `src/runtime/docker.ts` — if stream routing is influenced by how the process is launched
- After **Remove bash workflow modules**, container orchestration becomes Node-based; routing events to **stderr only** should be straightforward in **`emit.ts`** / kernel.

**Scope**

1. Ensure runtime (including any in-container orchestrator) writes **`__JAIPH_EVENT__`** lines **only to stderr** (or to the fd the CLI treats as “events”; document one channel).
2. Remove stdout event sniffing from the CLI **once** the runtime guarantees stderr-only contract.
3. Extend e2e contract tests if needed so regressions fail if events appear only on stdout.

**Acceptance criteria**

- CLI listens on **one** stream for structured events (stderr), or a single agreed pipe — not stdout+stdout for Docker and stderr for local.
- Documentation (**`ARCHITECTURE.md`**, contracts section) states one channel.

---

## Restore strict run-summary contract assertions (e2e 88) <!-- dev-ready -->

**Goal**  
Reinstate strict contract checks in `e2e/tests/88_run_summary_event_contract.sh`.

**Context**

- The test currently runs (not skipped) and validates: valid JSONL, single `run_id`, required event keys (`type`, `ts`, `run_id`, `event_version`), LOG persistence, WORKFLOW_START/END balance, STEP_START/END pairing, and INBOX_ENQUEUE presence.
- **Missing assertions**: The test does NOT check for `INBOX_DISPATCH_START`/`INBOX_DISPATCH_COMPLETE` events, even though the runtime already emits them (see `node-workflow-runtime.ts:762` and `inbox.ts:81`).
- This is a **test-gap task**, not a runtime implementation task — the events exist but are unasserted.

**Key files:**
- `e2e/tests/88_run_summary_event_contract.sh` — the test to harden (python3 inline script starts at line 62)
- `src/runtime/kernel/node-workflow-runtime.ts` — emits `INBOX_DISPATCH_START` (~line 762), `INBOX_DISPATCH_COMPLETE` (~line 783)
- `src/runtime/kernel/inbox.ts` — also emits dispatch start/complete (~lines 81, 103)

**Scope**

1. Add dispatch pairing assertions to the python3 contract validator:
   - Every `INBOX_DISPATCH_START` must have a matching `INBOX_DISPATCH_COMPLETE` for the same channel+target.
   - `INBOX_DISPATCH_START` must precede its matching `INBOX_DISPATCH_COMPLETE`.
   - Required payload fields: `channel`, `target`, `inbox_seq`.
2. Add the dispatch event types to the `want_types` tuple (line 156):
   - `"INBOX_DISPATCH_START"`, `"INBOX_DISPATCH_COMPLETE"`.
3. Define the canonical event contract in code comments at the top of the test.
4. If any event field discrepancy is found between what the test expects and what the runtime emits, update the test expectations to match the runtime (runtime is source of truth).

**Acceptance criteria**

- e2e 88 enforces dispatch start/complete pairing and passes.
- All expected event types are asserted.
- `run_summary.jsonl` contract is explicitly documented in test comments.

---

## Verify argument forwarding in managed calls (e2e 90) <!-- dev-ready -->

**Goal**  
Verify exact positional argument forwarding works end-to-end. Rename leftover `function` references to `script` in the test.

**Context**

- `e2e/tests/90_function_steps.sh` currently asserts exact `one|two words` values and correct tree output with `(1="one", 2="two words")`. The assertions appear hardened.
- The test file name and internal wording still use the old `function` terminology (e.g., "function calls in workflow tree", "function step command executed", `function_called.txt`, `function_args.txt`).
- The keyword was renamed from `function` to `script` in the language.

**Key files:**
- `e2e/tests/90_function_steps.sh` — the test
- `src/runtime/kernel/node-workflow-runtime.ts` — `executeRunRef` and argument mapping logic

**Scope**

1. Run the test to verify argument forwarding actually works end-to-end. If it fails, trace argument mapping in:
   - `executeRunRef` in `node-workflow-runtime.ts`
   - `executeRule` in `node-workflow-runtime.ts`
   - Nested workflow calls
   - Script invocation subprocess argument passing
2. Fix any propagation issues so quoted/space-containing args survive end-to-end.
3. Rename the test file from `90_function_steps.sh` to `90_script_steps.sh`.
4. Update all internal references: section titles, assertion messages, file names (`function_called.txt` → `script_called.txt`, `function_args.txt` → `script_args.txt`), and `.jh` fixture content.
5. Re-harden e2e assertions to exact expected output if any were weakened.

**Acceptance criteria**

- e2e 90 passes with exact `one|two words` checks.
- Tree display params match actual forwarded runtime args.
- No references to `function` remain in the test (all renamed to `script`).

---

## Isolate workflow metadata env (no cross-workflow bleed) <!-- dev-ready -->

**Goal**  
Ensure `agent.*` metadata applies only to the active workflow scope.

**Context**

- `applyMetadataScope` in `src/runtime/kernel/node-workflow-runtime.ts` (line ~933) takes `parentEnv`, `moduleMeta`, and `workflowMeta`, then merges config fields into a cloned env. It's called at:
  - Workflow execution (line ~385–391): creates `workflowEnv` from scope env + module/workflow metadata.
  - Rule execution (line ~435): creates `ruleEnv` from scope env + module metadata.
- The risk: sibling workflows in a single run share a parent env. If workflow A sets `agent.model = "gpt-5"` in its metadata, and workflow B doesn't, B could inherit A's model setting if the parent env was mutated rather than cloned.
- `JAIPH_*_LOCKED` guards in `src/cli/run/env.ts` (lines 25–35) protect CLI-provided overrides but do NOT protect against sibling workflow bleed within the runtime.
- The `LOCKED_ENV_KEYS` list: `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, `JAIPH_DEBUG`, `JAIPH_INBOX_PARALLEL`.

**Key files:**
- `src/runtime/kernel/node-workflow-runtime.ts` — `applyMetadataScope` (~line 933), workflow execution (~line 380)
- `src/cli/run/env.ts` — `LOCKED_ENV_KEYS`, `resolveRuntimeEnv`

**Scope**

1. Implement explicit metadata scope isolation in `NodeWorkflowRuntime`:
   - Option A: immutable per-workflow env derivation (clone parent env → apply metadata → pass to child scope, never mutate parent).
   - Option B: push/pop override stack keyed by workflow depth.
   - Prefer Option A (simpler, less stateful).
2. Write a regression test: two sibling workflows in one run, each with different `agent.*` metadata. Assert that workflow B does not see workflow A's metadata and vice versa.
3. Verify existing lock semantics from `src/cli/run/env.ts` remain intact (CLI-level env overrides still win).

**Acceptance criteria**

- Sibling workflows do not inherit each other's metadata-derived agent settings.
- Existing lock semantics remain intact.
- Regression test proves isolation (both unit and e2e).

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
