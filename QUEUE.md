# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Reject bare unknown words (incl. `true`) in `match` arm bodies #dev-ready

**Goal**
A bare word like `true`, `false`, `blorp`, etc. used as a `match` arm body must fail compilation as an unknown identifier. Today such tokens are silently treated as string literals — `_ => true` returns the literal string `"true"` and the rule passes. This is exactly the failure mode that allowed the `say_hello` validation rule to "work" with a meaningless default branch.

**Context (read before starting)**

* Commit `6c4b0ea` already rejects unknown leading verbs in arm bodies — but only when the verb is followed by arguments or `(` (e.g. `_ => error "msg"`). The current `validateMatchExpr` check does **not** fire for a bare word with no trailing tokens, so `_ => true` and `_ => blorp` slip through. This task closes that hole.
* The valid arm body forms are: string literal (single- or triple-quoted), bare in-scope identifier (`_ => name_arg`), `${var}` interpolation, `fail "..."`, `run ref(...)`, `ensure ref(...)`. Anything else must error.

**Scope**

* In `validateMatchExpr` (or the equivalent code path), reject any arm body that is a single bare word which is not a known in-scope identifier.
* Diagnostic must classify this as the existing unknown-identifier validation error (shape matching other "unknown name" errors elsewhere in the validator), not a shell/script error and not a generic parse error.
* Verify the same rule applies whether the leading-verb check fires first or not — the two checks together must cover both the with-args case (`_ => error "msg"`) and the bare-word case (`_ => true`).

**Non-goals**

* Do not introduce booleans into the language.
* Do not broaden expression syntax as part of this task.
* Do not change the valid forms enumerated above.

**Acceptance criteria**

* `match name { "" => fail "..." _ => true }` fails compilation with an unknown-identifier validation error.
* `match name { "" => fail "..." _ => blorp }` fails with the same error class.
* `match name { "" => fail "..." _ => "ok" }` continues to compile and run.
* `match name { "" => fail "..." _ => name }` (bare in-scope identifier) continues to compile and run.
* Regression tests cover all four cases above so `true`, `false`, and arbitrary bare unknowns cannot silently become accepted later.

***

## Bug: reject reassignment of immutable names (`const`, params, scripts) #dev-ready

**Goal**
Jaiph bindings are immutable. Compilation should fail when a workflow/rule parameter, a `const` name, or a `script` name is redefined/reassigned in the same visible scope.

**Repro**

```jh
workflow default(name_arg) {
  const name_arg = ensure valid_name(name_arg)
}
```

This should fail compile: parameter `name_arg` cannot be rebound by `const`.

**Context (read before starting)**

* `examples/say_hello.jh` currently uses this exact pattern (`workflow default(name_arg) { const name_arg = ensure valid_name(name_arg) ... }`). Implementing this task will break that file at compile time, and the example must be fixed in the same change. The simplest fix is to rename the parameter (e.g. `name_input`) and bind a new `const name_arg = ensure valid_name(name_input)`. Apply the same audit to `examples/*.jh`, `examples/*.test.jh`, and `.jaiph/*.jh` — any other file with a param/const collision must be migrated in this PR.

**Scope**

* Enforce immutability checks during validation for:
  - parameter name shadow/rebind via `const`,
  - duplicate `const` declarations in the same scope,
  - `script` name collisions with immutable names where they are visible.
* Ensure diagnostics are explicit about immutable-name reassignment: which name, and where it was first bound (file + line).
* Apply consistently in workflows and rules.
* Migrate every file in the repo that currently violates the new rule (examples, `.jaiph/`, e2e fixtures) as part of this PR; the queue task is not done while a checked-in `.jh` file fails compilation.
* Add/extend tests to cover success + failure cases.

**Non-goals**

* Do not change runtime semantics.
* Do not introduce mutable assignment syntax.

**Acceptance criteria**

* The repro fails compilation with an immutable-binding error that names the conflicting binding and its origin.
* Rebinding any parameter via `const` is rejected.
* Duplicate `const` names in the same scope are rejected.
* Rebinding/conflicting `script` names is rejected where applicable.
* `npm test` and `bash e2e/test_all.sh` pass with no `.jh` file in the repo violating the new rule.
* Tests lock behavior to prevent regression.

***

## Support `return <identifier>` and stop misrouting it through the shell-step validator #dev-ready

**Goal**
`return response` (bare identifier in return position) must be a first-class return form. Today it falls through to the catch-all "inline shell steps are forbidden in workflows; use explicit script blocks" `E_VALIDATE` error, which is wrong on three counts: it is not a shell statement, the user is not asked to write one, and the suggested fix (script block) does not solve the problem. Two separate symptoms — "identifier return is not accepted" and "the diagnostic is shell-flavored" — share a single root cause: the validator's bare-statement fallthrough swallows everything it does not explicitly recognize.

**Repro**

```jh
workflow default(name) {
  const response = prompt """
    Say hello to ${name}.
  """
  return response
}
```

Current output: `<file>:N:M E_VALIDATE inline shell steps are forbidden in workflows; use explicit script blocks`.

**Scope**

* Update parser/validator so workflow/rule return values accept bare identifiers (`return response`), resolved against the same scope rules used for `${ident}` interpolation and bare-identifier call arguments.
* Audit every emit site of the "inline shell steps are forbidden" `E_VALIDATE` message. Either narrow it to actual inline-shell cases, or replace it entirely with construct-specific diagnostics. After this change, the message must only appear when the user actually wrote a bare shell command.
* Unknown-identifier returns (`return missing_name` where `missing_name` is not in scope) must produce a precise unknown-identifier error, naming the missing binding.
* Keep existing valid return forms working unchanged: `return "..."`, `return """..."""`, `return "${ident}"`, `return run ...`, `return ensure ...`, `return match ...`, dotted returns.
* Tests must cover: (a) `return response` accepted when in scope; (b) `return missing` rejected with unknown-identifier error; (c) the "inline shell steps" message no longer fires for any non-shell construct in the test suite; (d) `return "${response}"` still accepted.

**Non-goals**

* Do not remove `return "${response}"`; both forms remain valid.
* Do not broaden return syntax beyond bare identifiers and the diagnostic cleanup.
* Do not add compatibility shims for the old misleading message.

**Acceptance criteria**

* The repro compiles and runs; `return response` propagates the captured prompt response.
* `return <unknown>` produces an unknown-identifier validation error naming the missing binding (not a shell-step error).
* No checked-in `.jh` file produces the "inline shell steps are forbidden" error after this change unless it actually contains a bare shell command.
* `return "${response}"` and all other listed return forms still parse, validate, and run.
* Regression tests in `src/transpile/` and an e2e covering the repro are added and fail without the fix.

***

## Cleanup — consolidate the 5-way test directory split #dev-ready

**Goal**
Today there are five different places that contain "tests": `src/**/*.test.ts` (66 unit tests, adjacent to source), `test/` (4 integration files including a 2427-LoC `sample-build.test.ts`), `tests/e2e-samples/` (a single Playwright file), `compiler-tests/` (txtar fixtures), `golden-ast/` (fixtures + expected). Plus runners `src/compiler-test-runner.ts` and `src/golden-ast-runner.ts` mixed into the production source tree. A new contributor cannot tell where a new test belongs without reading the whole layout. Fix the structure in one pass.

**Context (read before starting)**

* The current `package.json` `test` script enumerates the test sources explicitly; this gives us a precise inventory of what is wired in:
  ```
  dist/test/*.test.js
  dist/src/**/*.test.js
  dist/src/**/*.acceptance.test.js
  dist/src/compiler-test-runner.js
  dist/src/golden-ast-runner.js
  ```
  Any move must update this script and keep the same test set running. Adding tests is out of scope; this is purely reorganization.
* `src/compiler-test-runner.ts` and `src/golden-ast-runner.ts` are compiled and shipped in `dist/`, but they are test infrastructure (they consume fixtures, produce assertions). They should not live in `src/`.
* `compiler-tests/README.md` already documents the txtar format — preserve that doc next to the fixtures it describes.

**Scope**

* **Move test infrastructure out of `src/`**:
  - `src/compiler-test-runner.ts` → `test-infra/compiler-test-runner.ts`
  - `src/golden-ast-runner.ts` → `test-infra/golden-ast-runner.ts`
  - `tsconfig.json` and `package.json` `test` script updated to reference the new locations.
* **Rename and group fixture directories**:
  - `compiler-tests/` → `test-fixtures/compiler-txtar/` (preserves the README inside).
  - `golden-ast/` → `test-fixtures/golden-ast/` (preserves the `fixtures/` and `expected/` subdirs underneath).
  - Update path references in `test-infra/compiler-test-runner.ts` and `test-infra/golden-ast-runner.ts`.
* **Fold the singleton Playwright test**:
  - `tests/e2e-samples/landing-page.spec.ts` → `e2e/playwright/landing-page.spec.ts`.
  - Update `playwright.config.ts` and the `test:samples` npm script accordingly.
  - Delete the now-empty `tests/` directory.
* **Triage `test/` (4 files, 2960 LoC)**:
  - `test/run-summary-jsonl.test.ts` (178 LoC), `test/signal-lifecycle.test.ts` (220 LoC), `test/tty-running-timer.test.ts` (135 LoC) — keep in a renamed `integration/` directory. They are integration-flavored, not unit, and don't have an obvious adjacent home.
  - `test/sample-build.test.ts` (2427 LoC) — split. Read the file, group its tests by which subsystem they actually exercise, and move each group either next to that subsystem (`src/.../<name>.integration.test.ts`) or into `integration/sample-build/<topic>.test.ts`. Aim for no resulting file over ~600 LoC. The split is the work; it is not optional.
  - Move `test/expected/` and `test/fixtures/` to `test-fixtures/sample-build/` if any test still references them after the split.
* **Final layout** (target):
  ```
  src/**/*.test.ts                       # unit, adjacent (unchanged)
  src/**/*.acceptance.test.ts            # acceptance, adjacent (unchanged)
  integration/**/*.test.ts               # integration tests (was `test/`, after split)
  test-fixtures/compiler-txtar/          # was `compiler-tests/`
  test-fixtures/golden-ast/              # was `golden-ast/`
  test-fixtures/sample-build/            # if any sample-build fixtures survive the split
  test-infra/compiler-test-runner.ts     # was `src/compiler-test-runner.ts`
  test-infra/golden-ast-runner.ts        # was `src/golden-ast-runner.ts`
  e2e/                                   # shell + .jh (unchanged)
  e2e/playwright/landing-page.spec.ts    # was `tests/e2e-samples/`
  ```
  Three test "places" instead of five (`src/`-adjacent, `integration/`, `e2e/`); plus two clearly named support directories (`test-fixtures/`, `test-infra/`).
* Update `package.json` `test`, `test:compiler`, `test:golden-ast`, `test:samples`, `test:acceptance`, `test:ci`, `test:e2e` scripts to reference the new paths. Verify by running `npm test` end-to-end.

**Non-goals**

* Do not change any test's logic, assertions, or fixtures' contents. The goal is layout, not behavior.
* Do not change the unit-tests-adjacent-to-source convention. That part works.
* Do not delete any test (other than ones absorbed into the `sample-build.test.ts` split, where the original file goes away after redistribution).

**Acceptance criteria**

* `npm test` passes with the same test count (or higher, if the `sample-build` split surfaces previously-bundled cases as separate tests). Test count must not decrease.
* No file in `src/` is named `*-test-runner.ts`. Test infrastructure lives only in `test-infra/`.
* No file under `integration/` exceeds ~600 LoC after the `sample-build` split.
* The repo root no longer has both `test/` and `tests/`. (`tests/` is deleted after folding.)
* `package.json` test scripts reference the new paths and the same test set runs in CI.
* Commit message documents the file-move map (old → new) so reviewers can sanity-check that nothing was lost.

***

## Refactor — split `src/runtime/kernel/node-workflow-runtime.ts` (1901 LoC) #dev-ready

**Goal**
`src/runtime/kernel/node-workflow-runtime.ts` is a 1901-LoC god file: ~280 LoC of free arg-parsing helpers above the class, then ~1620 LoC of `NodeWorkflowRuntime` spanning workflow orchestration, step execution, prompt step lifecycle, event emission, mock execution, frame stack management, and heartbeat I/O. Reading or modifying any one concern requires holding all of them in head. Split along clean seams so each concern is in a focused module.

**Context (read before starting)**

* This file is actively touched by the `Handle<T>` task. If that task is in flight, **rebase on it before splitting** — do not do this work in parallel without coordinating, or the merge will be miserable.
* The class has stateful internals (`runId`, `runDir`, `summaryFile`, `heartbeatTimer`, `frameStack`, `asyncIndices`, `env`, `cwd`, `graph`, `mockBodies`). The split must keep state in the class and move stateless helpers out, or pass state explicitly into the extracted modules. Do not invent a second source of truth.
* Free helpers above the class (`interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH`, `sanitizeName`, `nowIso`) — all stateless. Safe to extract.
* Methods that are pure event emission (`emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`) all call `appendRunSummaryLine` and `process.stderr.write`. They depend on the class only for `runId`, `summaryFile`, and `getAsyncIndices()`. Can move to a module that takes those as constructor args.
* Mock execution methods (`executeMockBodyDef`, `executeMockShellBody`) are largely self-contained and could move to a sibling module.

**Scope**

Extract three new sibling modules under `src/runtime/kernel/`:

* **`runtime-arg-parser.ts`** — every stateless free helper currently above the `NodeWorkflowRuntime` class:
  - `interpolate`, `parseInlineCaptureCall`, `commaArgsToInterpolated`, `parseArgsRaw`, `parseInlineScriptAt`, `parseManagedArgAt`, `parseArgTokens`, `stripOuterQuotes`, `parsePromptSchema`, `sanitizeName`, `nowIso`
  - The `BARE_IDENT_RE`, `MAX_EMBED`, `MAX_RECURSION_DEPTH` constants
  - The `ParsedArgToken`, `PromptSchemaField` types if they are not used elsewhere in the class
  - **Required**: extracted helpers must have unit tests (some already do indirectly via runtime tests; new direct tests live in `runtime-arg-parser.test.ts`).
* **`runtime-event-emitter.ts`** — a small class `RuntimeEventEmitter` constructed with `{ runId, asyncIndicesGetter, env }`, exposing `emitWorkflow`, `emitStep`, `emitPromptStepStart`, `emitPromptStepEnd`, `emitPromptEvent`, `emitLog`. The runtime constructs one and delegates. No more direct `process.stderr.write(__JAIPH_EVENT__ ...)` scattered through the runtime.
* **`runtime-mock.ts`** — `executeMockBodyDef` and `executeMockShellBody` move here as exported functions taking `{ ref, args, env, cwd, executeStepsBack }` (the last is a callback so the mock can dispatch back into the runtime for `kind: "steps"` mocks). Removes the `require("node:child_process")` and `require("node:fs")` calls that currently shadow ESM imports inside the class body — that is a code smell that should die in this task.

After the split, `node-workflow-runtime.ts` keeps only:
* The `NodeWorkflowRuntime` class
* Workflow/step orchestration (`runDefault`, `runNamedWorkflow`, `executeSteps`, `executeStep`, frame and scope management)
* The async-handle bookkeeping (`getAsyncIndices`, `getFrameStack`)
* Heartbeat (`startHeartbeat`, `stopHeartbeat`, `writeHeartbeat`)

Target size for `node-workflow-runtime.ts` after split: ~1000–1200 LoC. Still large, but a single coherent concern (the orchestrator).

**Non-goals**

* Do not change behavior. Every existing test must still pass without modification.
* Do not redesign the event format, the mock contract, or the arg-parser's accepted syntax. This is a relocation task only.
* Do not split further than the three new modules listed. Over-decomposition is its own problem; this task is calibrated for one round of splitting.
* Do not touch `node-workflow-runner.ts` (the CLI shim) or `run-step-exec.ts` (subprocess plumbing) — those are already correctly sized and out of scope.

**Acceptance criteria**

* `src/runtime/kernel/node-workflow-runtime.ts` is between 1000 and 1200 LoC after the split.
* `src/runtime/kernel/runtime-arg-parser.ts`, `runtime-event-emitter.ts`, `runtime-mock.ts` exist and own their respective concerns.
* `runtime-arg-parser.test.ts` exists with direct unit tests for the extracted helpers.
* `npm test` passes with no test changes other than possibly importing helpers from their new location.
* No `require("node:...")` calls inside class methods (they are replaced by top-of-file `import` statements as part of the mock extraction).
* The new modules have no circular imports back into `node-workflow-runtime.ts`. Dependency direction is one-way: orchestrator → helpers/emitter/mock.

***
