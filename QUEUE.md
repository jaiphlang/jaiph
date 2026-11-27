# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed
   by `pick_task` or by the engineer workflow.
4. Queue changes go through `.jaiph/libs/jaiphlang/queue.py` only: the
   product-owner defs, or the engineer, architect-review and security-review
   workflows. Never by editing this file.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Support string enums and arrays of records in prompt returns schemas #dev-ready

Source: Jaiph Factory contract design, 2026-11-27. The factory's stage flows want every agent step to return a typed result through `prompt … returns "{…}"`, but today's schema is too flat for their real outputs.

### Current behavior

A `returns` schema is a flat `{ field: type, … }` with `string`, `number` or `boolean` fields (`docs/language.md`, "`prompt` — agent interaction" and "Named prompts"; parsed in `src/parse/prompt.ts`). Two common needs do not fit:

- A field that must be one of a few words, such as a review verdict, can only be `string`. Every caller then re-validates the value by hand, and a typo from the agent (`aprove`) passes the schema.
- A list of records, such as the files and line ranges an agent cites, has to travel as a JSON string inside a `string` field, so the caller parses it again and the schema says nothing about its shape.

### Wanted

1. **String enums.** A field type written as a union of string literals, for example `status: "approve" | "reject" | "unsure"`. The returned value must be exactly one of the literals; anything else is a deterministic post-processing failure (not a transport retry), with an error that names the field, the value and the allowed literals.
2. **Arrays of records.** A field type written as `[ { … } ]` with the same field types inside (string, number, boolean, string enum), for example `key_changes: [{ path: string, start: number, end: number, note: string }]`. One level of nesting is enough; records inside records are out of scope.
3. **Access.** `result.status` works as today and compares in `if` / `match` as a string. An array field is passed on as its JSON text (to a script, `return`, interpolation, or as a call argument), so existing code that treats it as a string keeps working. `result.key_changes.path` and indexing are out of scope.
4. **Prompt instruction.** The schema text the runtime adds to the prompt (telling the agent what JSON to return) describes enums and arrays in plain words, so agents produce them reliably.
5. **Docs.** `docs/language.md` (the `returns` rows for steps and named prompts) and `docs/grammar.md` (the `returns_schema` description, which stays a double-quoted string) describe both types with one example each.

### Acceptance criteria

- A schema with an enum field accepts each listed literal and rejects any other value with an error naming the field, the value and the allowed literals; that rejection does not trigger the transport retry backoff.
- A schema with an array-of-records field accepts a JSON array of matching objects (including an empty array), and rejects a non-array, a record missing a declared field, or a field of the wrong type, each with an error naming the path (for example `key_changes[2].start`).
- Enum fields inside array records are validated the same way.
- `result.field` for an enum compares in `if` and `match`; an array field interpolates and passes to a script as its JSON text.
- Malformed schemas (an empty union, `"a" |`, a nested `[[…]]`, a record inside a record) are `E_PARSE` at compile time with a message that says what to change.
- Existing flat schemas behave exactly as before (the current `returns` tests pass unchanged).
- Every bullet above has a test that fails when the behavior is broken; `docs/language.md` and `docs/grammar.md` examples compile.

## Accept a trailing # comment after any statement, and compile the doc samples #dev-ready

Source: code audit 2026-11-15. Reproduced with the built CLI.

### Current behavior

The docs contradict each other and the parser:

- `docs/grammar.md` line 23: "Trailing `#` on a step line is not a comment."
- `docs/grammar.md` line 346: trailing text after `log`/`fail`/`return` is an error "where a trailing `#` comment is still allowed".
- `rejectTrailingAfterString` (`src/parse/block-ctx.ts` around line 99) allows `#` after `fail "…"` and `return "…"`. `parseSayBody` (`src/parse/stmt-say.ts` around line 79) rejects it after `log "…"`.

Accepted today: `const a = "v"  # c`, `return "ok"  # c`, `fail "x"  # c`. Rejected: `log "x" # c`, `helper(h)  # c`, `const b = helper(h)  # c`, `if … {  # c`, `const y = 'date'()  # c`, `return h  # c`, `log h  # c`.

Doc samples fail for this reason: `docs/language.md` lines 171, 200, 365, 410–412, 417 and `docs/testing.md` lines 104–106. No test compiles doc samples; `integration/docs-grammar-language-split.test.ts` only greps.

### Required behavior

- A `#` preceded by whitespace, outside any string / `"""` block / script body, starts a comment that runs to end of line, after any complete statement and after a block-opening `{`, in `.jh` and `.test.jh`.
- The comment is kept as trivia and the formatter preserves it (normalised to two spaces before `#`).
- `docs/grammar.md` states one rule in both places.
- New integration test that extracts every `jaiph` / `jh` fenced block from `docs/*.md` and `README.md` and compiles it (wrap statement fragments in a def). A fence can opt out with an explicit marker (for example an HTML comment `<!-- no-compile: reason -->` on the line before); every opt-out carries a reason.

### Acceptance

- Each rejected form listed above now parses; add them to the valid txtar cases and to formatter round-trip tests.
- `#` inside a string, a `"""` block, an inline script and a script body is unchanged.
- The doc-sample test passes with all samples in `docs/language.md` and `docs/testing.md` compiled, not opted out, unless they show an error on purpose.
- `integration/format-roundtrip.test.ts`, `npm test`, `bash e2e/test_all.sh` pass. Tree-sitter / TextMate grammars under `grammars/` and `plugins/` highlight the trailing comment. CHANGELOG entry under Unreleased.

## Make parse errors for common agent mistakes say what to change #dev-ready

Source: code audit 2026-11-15. Messages captured verbatim from the built CLI.

### Current behavior

| Input (inside a def) | Message today | Problem |
|---|---|---|
| `h` where `h` is a def (missing parentheses) | `E_PARSE not a statement; put the command in a script` (`src/parse/stmt-decl.ts` near line 198) | Sends the author to write a script instead of adding `()` |
| `while a == "x" {` | same message | No hint about `for` / `recover` |
| `log 'hello'` | `anonymous inline script requires argument list after closing quote: 'body'(args) or 'body'()` (`src/parse/inline-script.ts` near line 109) | A wrong-quote mistake reported as a script problem |
| `h() \|\| fail "x"` | `unexpected content after call call: '…'; shell redirection (>, \|, &) is not supported — use a script block` (`src/parse/core.ts` near line 91) | "call call" stutter, column 1, should point to `catch` |
| `const r = prompt Summarize this` | `after prompt body expected keyword "returns" with quoted schema … or end of line` | The real problem is the unquoted prompt body |
| `const r = prompt "x" returns { verdict: string }` | same message | `returns` is present; the schema lacks quotes |
| `if a == b {` / `if a {` | `invalid if syntax; expected: if <identifier> <op> <operand> { ... }` | Does not say which part is wrong |
| `export def main(a = "x")` | `invalid parameter name "a = "x""; must be an identifier` | Should say defaults and types are not supported |

### Required behavior

Messages (code stays `E_PARSE`, column points at the offending token, never column 1 unless that is where it is):

- bare identifier that is the name of a def or script visible to the parser in the same module → `"h" is a def; call it with parentheses: h()`. For any other bare word keep the existing message.
- `while …` → `"while" is not supported; use "for <name> in <list>" or "recover" to loop`. Same style for `try` (→ `catch`).
- single-quoted text after `log` / `logerr` / `logwarn` / `fail` / `return` with no `(` after the closing quote → `strings use double quotes: "hello"`.
- `call() || …` and `call() && …` → `"||" is not supported; handle failure with: call() catch (err) { … }`. Fix the "call call" stutter everywhere.
- unquoted prompt body → `prompt text must be a quoted string or """ block`.
- `returns` followed by a non-string → `returns schema must be a quoted string: returns "{ verdict: string }"`.
- `if` with a missing operator → `if needs a comparison: if <name> == "value" { … }`; `if` with a non-literal right operand → say the right side must be a string, regex or number literal (match what the parser really accepts).
- parameter with `=` or `:` → `parameters are bare names; default values and types are not supported`.

### Acceptance

- Every input in the table (plus `try {` and `h() && g()`) is in `test-fixtures/compiler-txtar/parse-errors.txt` with the new message and correct column; snapshot refreshed.
- No message in the snapshot contains `call call`.
- `docs/jaiph-skill.md` "common mistakes" section lists the same fixes; run `npm run build` so `src/runtime/embedded-assets.ts` matches it.
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Describe MCP tool parameters from def comments #dev-ready

Source: code audit 2026-11-15. Confirmed with a live `tools/list`.

### Current behavior

`src/cli/shared/mcp-tools.ts` (around lines 54–60) emits `{ "type": "string" }` for every parameter, all required, with no per-parameter description. An exported def with no comment gets the description `Run the "explode" def from tools.jh.` The repo's own hub (`.jaiph/main.jh`) explains parameters in free-text comments and uses the convention "optional args use \"\"". The OpenAPI document (`src/cli/serve/openapi.ts`) has the same gap.

### Required behavior

- In the comment block directly above an exported def, a line of the form `# name: text` where `name` is one of the def's parameters becomes `properties[name].description` in the MCP input schema and the OpenAPI request schema. Those lines are removed from the tool description; the rest of the comment stays the description.
- `jaiph mcp` and `jaiph serve` print one warning to stderr at startup for each exported def with no comment, and for each parameter with no description. No warning in `jaiph run`.
- No change to required-ness or types.

### Acceptance

- `src/cli/shared/mcp-tools.test.ts`: comment with two `# name: text` lines gives two parameter descriptions and a tool description without those lines; a `# other: text` line that names no parameter stays in the description.
- OpenAPI unit test for the same def.
- Test that the warning is printed once per undocumented def by `jaiph mcp` and not by `jaiph run`.
- `docs/mcp.md` and `docs/jaiph-skill.md` document the comment form (`npm run build` to refresh `src/runtime/embedded-assets.ts`). CHANGELOG entry under Unreleased.

## Fix AGENT.md test paths and CLI usage drift #dev-ready

Source: code audit 2026-11-15.

### Current behavior

- `AGENT.md` says cross-cutting tests live in `test/*.test.ts`, new ones "go in `test/`", and lists `node --test dist/test/*.test.js`. Neither `test/` nor `dist/test/` exists. The real location is `integration/*.test.ts`, compiled to `dist/integration/`. A worker following the file creates a tree nothing runs, or runs a glob that matches nothing and reports success.
- `src/cli/shared/usage.ts`: the synopsis shows `jaiph test [path]` and "Shared flags (jaiph run, jaiph serve, jaiph mcp)", but `jaiph test` accepts `--env` (`src/cli/commands/test.ts`). The `jaiph install [--force] …` synopsis omits `--allow-unpinned`. `docs/cli.md` (around lines 116–118 and 221) has the same omissions.

### Required behavior

- `AGENT.md` names `integration/*.test.ts` and `node --test dist/integration/*.test.js`, and lists `npm test`, `npm run lint`, `npm run arch:check`.
- Usage text and `docs/cli.md` show `--env` for `jaiph test` and `--allow-unpinned` for `jaiph install`.

### Acceptance

- Extend `integration/factory-code-philosophy.test.ts` (it already reads `AGENT.md`), or add a sibling test: every backticked repo-relative path in `AGENT.md` exists (glob patterns must match at least one file).
- A test that every flag a command's parser accepts appears in that command's synopsis line in `usage.ts`.
- `npm test` passes.

## Turn the lint cap exemptions into a ratchet #dev-ready

Source: code audit 2026-11-15.

### Current behavior

`eslint.config.mjs` turns `max-lines` (cap 400) and the runtime-import cap (8) `"off"` for three files with a "do not extend" comment. `src/eslint-caps.test.ts` only checks which files are exempt, not their size. Since the exemption was added, `src/runtime/kernel/node-workflow-runtime.ts` grew from 1698 to 2153 counted lines.

Measured today (counted lines / runtime import sources): `node-workflow-runtime.ts` 2153 / 25, `src/cli/serve/handler.ts` 587 / 13, `src/cli/commands/run.ts` 480 / 24. The numbers in the override comments are stale.

### Required behavior

- Replace `"off"` with per-file maxima equal to today's measured values (re-measure at implementation time).
- The caps test asserts, for each exempt file, that the configured maximum equals the measured value, so a split must lower the number in the same change and growth fails lint.
- `docs/agent-analyzability.md` describes the ratchet.

### Acceptance

- `npm run lint` passes unchanged.
- Adding one counted line or one import source to an exempt file fails lint (test with a synthetic copy, as the existing caps tests do).
- A configured maximum above the measured value fails `src/eslint-caps.test.ts`.

## Extract script subprocess execution from the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

`src/runtime/kernel/node-workflow-runtime.ts` is 2801 lines. About 330 of them run a script as a child process and use no instance state: `_scriptSpawn`, `argvEnvByteSize`, `spawnFailureText`, `spawnAndCapture`, `scriptCwd`, `executeScript`, `resolveScriptInterpreter` (around lines 71–115, 204–222, 2277–2492). Tests reach them through casts such as `runtime as unknown as { executeScript }` (`node-workflow-runtime.spawn-failure.test.ts`, `script-exec.test.ts`).

### Required behavior

- New module in `src/runtime/kernel/` with one public function, for example `runScriptProcess({ scriptsDir, scriptName, args, env, cwdFallback, io, stdin, onSpawn }): Promise<StepResult>`, plus the `StdinSource` / `StepIO` types it needs.
- It hides: shebang/interpreter resolution, the stdout tee and backpressure, single-settle, idle-kill, and the mapping of E2BIG / ENOENT spawn failures to step results.
- The runtime class calls it. Tests call the public function instead of casting to private members.
- The new file is under the 400-line and 8-import caps. Lower the lint maximum for `node-workflow-runtime.ts` if the caps are a ratchet by then.

### Acceptance

- `node-workflow-runtime.spawn-failure`, `script-exec` and `idle-kill` tests pass with no `as unknown as` cast to reach script execution.
- Journal lines, step artifacts and error texts are byte-identical: run a before/after differential of `run_summary.jsonl` (normalise timestamps, ids and hashes) and captured files over the e2e workflows that use scripts, and report the diff count (must be 0).
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.

## Extract output handles and the config-to-env table from the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

In `src/runtime/kernel/node-workflow-runtime.ts`:

- Output handles: lines around 294–380 and 2201–2269 plus the fields `handleRegistry`, `handleIdCounter`, `recoverMergeCounter`. Duplicates inside: `readFilePreview` (near 1998) and `readCapturePreview` (near 2787) are the same function; `handleStdinSource` (near 351) repeats lines near 1992; the bare-handle regex appears near 1645 and 1986.
- Metadata to env: `applyMetadataScope`, `scrubKernelKeys`, `resolveConfigAgentModel`, `resolveRecoverLimit` (around 2529–2637). `applyMetadataScope` is six near-identical LOCKED / IMPORT_UNLOCK blocks. `src/cli/run/env.ts` (lines 8–65) repeats the same config-key to env-key mapping. `env.ts` sets `JAIPH_AGENT_MODEL_LOCKED`, which nothing reads.

### Required behavior

- `class OutputHandles { create(ref, promise); createResolved(ref, result); is(value); resolve(id) }` plus pure helpers for forcing a value, deriving a stdin source, and merging failure captures, in their own module. One preview reader, one bare-handle pattern.
- One exported table `{ metaPath, envKey, entryOnly }[]` in the runtime package, used by `applyMetadataScope` and by `resolveRuntimeEnv` in `src/cli/run/env.ts` through the runtime's public entry.
- Remove the unread `JAIPH_AGENT_MODEL_LOCKED` write, or wire it up if the docs promise it (check `docs/env-vars.md`; keep docs and code in parity).
- New files are under the lint caps.

### Acceptance

- Unit tests for `OutputHandles` and for the table-driven `applyMetadataScope` covering each key in locked, unlocked, entry-module and imported-module cases; expected values taken from the current implementation.
- Existing runtime tests, `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.
- `node-workflow-runtime.ts` counted lines drop; update its lint maximum.

## Use one failure-policy helper for exec steps in the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

In `src/runtime/kernel/node-workflow-runtime.ts`, the catch / recover / retry handling around a step is written three times: for a call step (around lines 1253–1320), for an inline script step (1321–1384), and for the async variant (1220–1247). Each copy is about 65 lines. `runNamedDef` (around 694–716) stops the heartbeat without `try/finally`, unlike `runRoot`.

### Required behavior

- One function, for example `runWithFailurePolicy(step, scope, runOnce: (stdin?) => Promise<StepResult>)`, used by all three sites.
- `runNamedDef` stops the heartbeat in `finally`.

### Acceptance

- Existing catch / recover / async tests pass unchanged.
- New test: `runNamedDef` on a def that throws leaves no heartbeat timer running.
- Before/after differential of journals over the e2e workflows that use `catch` and `recover` shows 0 diffs after normalisation.
- `npm test`, `npm run lint`, `bash e2e/test_all.sh` pass; lint maximum for the file lowered.

## Launch host runs through one module #dev-ready

Source: code audit 2026-11-15.

### Current behavior

Preparing and spawning a workflow leader (runtime env, `JAIPH_SOURCE_ABS`, run id, chain key, grant file, scripts dir, meta file, spawn, `writeChainKey`, cleanup) is written three times: `src/cli/commands/run.ts` lines 132–172, `run.ts` lines 275–303 (raw mode), and `src/cli/shared/workflow-call.ts` with `workflow-call-exec.ts`. The copies have drifted:

- raw mode uses `runtimeEnv[CHAIN_KEY_ENV] ?? generateChainKey()`; the other two always generate
- raw mode never sets `JAIPH_RUN_ID`

Leftovers from the bash runtime: `dummyBuiltPath = join(outDir, "entry.sh")` (`run.ts` near 294 and 382, `workflow-call-exec.ts` near 46) names a file that never exists and is used only for a `JAIPH_SCRIPTS` fallback in `node-workflow-runner.ts`; `JAIPH_META_FILE` is set in `workflow-launch.ts` and never read. The stderr line splitter is duplicated (`run.ts` 404–413, `workflow-call-exec.ts` 146–153; the latter caps output per completed line, so a stream with no newline grows without limit). `buf.stdout` in `run.ts` is never written, so the stdout branch of `drainBuffers` is dead. `src/cli/shared` imports from `run/*` and `telemetry/*`, so `serve` depends on `run` transitively.

### Required behavior

- One module (for example `src/cli/shared/host-run.ts`) with `launchHostRun({ inputAbs, workspaceRoot, outDir, scriptsDir, graphFile?, def, args, extraEnv, effectiveConfig, stdio, runId? })` returning `{ child, done: Promise<{ status, signal, runDir, summaryFile }>, cancel() }`. It owns env construction, chain key, grant file, meta file, timeout and cleanup.
- `jaiph run`, `jaiph run --raw`, serve and MCP all use it. Raw mode gets a run id and always generates a fresh chain key (state this in the CHANGELOG).
- Remove `entry.sh`, the `JAIPH_SCRIPTS` fallback and `JAIPH_META_FILE` if nothing reads them (keep `docs/env-vars.md` in parity). One stderr line splitter with a maximum line length.
- Move what the launcher needs out of `src/cli/run/` so `src/cli/shared` no longer imports from `src/cli/run`; add that as a dependency-cruiser rule.

### Acceptance

- Test: raw mode journal has a run id and verifies.
- Test: a 10 MB stderr line with no newline does not grow the splitter's buffer past the cap.
- `npm run arch:check` has a rule (with a synthetic-violation case in `src/arch-check.test.ts`) that `src/cli/shared` does not import `src/cli/run`.
- `integration/signal-lifecycle.test.ts`, `serve-server.test.ts`, `mcp-server.test.ts`, `run-summary-jsonl.test.ts`, workflow-launch tests, `npm test`, `npm run lint`, `bash e2e/test_all.sh` pass.
- `docs/architecture.md` describes the single launcher. CHANGELOG entry under Unreleased.

## Split progress rendering and result reporting out of the run command #dev-ready

Source: code audit 2026-11-15. No behaviour change in output.

### Current behavior

`src/cli/commands/run.ts` is exempt from the lint caps (480 counted lines, 24 import sources). Two clusters hold most of it:

- progress session: lines around 174–242 and 389–456 (`ttyCtx`, both intervals, `wireStreams`, `drainBuffers`, bottom-line clear/redraw)
- result report: lines around 458–543, `reportResult` with 11 positional parameters

`statSync(inputAbs)` near line 114 is unguarded: a missing file prints a raw `ENOENT … stat` message. `src/cli/commands/init.ts` line 52 has the same pattern, and `src/cli/commands/init.test.ts:92` is skipped with a note pointing to `.jaiph/tmp/qa_bug_report.md`, which is not in the repo. `src/cli/shared/paths.test.ts:19` silently skips when `.jaiph/tmp` does not exist.

### Required behavior

- `startProgressSession(child, emitter, { isTTY, colorEnabled, startedAt }): { stop() }` in `src/cli/run/`.
- `reportRunResult(outcome: RunOutcome): Promise<number>` in `src/cli/run/report.ts`, taking one object.
- `runWorkflow` reads as: parse args, load graph, preflight, launch, report. Remove `run.ts` from the lint cap exemptions if it now fits; otherwise lower its maxima.
- A missing or unreadable input path in `jaiph run` and `jaiph init` prints a one-line error naming the path and exits non-zero, with no stack or raw errno text.
- Unskip `init.test.ts:92`. `paths.test.ts` creates its sandbox directory instead of skipping.

### Acceptance

- `integration/tty-running-timer.test.ts` and all e2e golden trees pass unchanged.
- New tests: `jaiph run missing.jh` and the `init` case print the stated error.
- No `test.skip` / `{ skip: … }` remains in `init.test.ts` or `paths.test.ts`.
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.

## Extract a run registry and a route table from the serve handler #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

`src/cli/serve/handler.ts` is exempt from the lint caps (587 counted lines, 13 import sources).

- About 220 lines own the run state: `runs`, `orderCounter`, `idempotencyIndex` (around lines 63–72, 149–221, 312–318, 578–623, 767–803).
- Routing (lines 324–372) repeats "check method, check capability, decode id" eight times; the auth block is duplicated near 268–277.
- Argument validation (lines 413–420) repeats `src/cli/shared/mcp-server.ts` near line 237.

### Required behavior

- `class RunRegistry { start(spec, args, identity, hooks); get(id, principal); list(principal, page); cancel(id); findIdempotent(key, argsHash); inFlight(); cancelAll() }` in its own file. It hides the concurrency cap, the cancel-before-spawn race, eviction, idempotency reservation, persistence, and ownership filtering.
- Routing is a table `{ method, pattern, capability, handle }[]`, with auth and capability checks applied in one place.
- MCP-over-HTTP and the run-file endpoints (events, artifacts) are two route modules over the registry.
- One shared `validateToolArgs(spec, raw)` used by REST and MCP.
- Every file is under the lint caps; remove `handler.ts` from the exemptions.

### Acceptance

- Handler unit tests, `integration/serve-server.test.ts`, `serve-auth.test.ts`, `serve-restart.test.ts` and the OpenAPI validation test pass with no change to expected status codes or bodies.
- Unit tests for `RunRegistry`: concurrency cap, cancel before spawn, idempotent replay, cross-principal `get` returns nothing.
- A test that every route in the table declares a capability or is in an explicit list of open routes (`/healthz`, `/docs`, `/openapi.json`, assets).
- `npm test`, `npm run lint`, `npm run arch:check` pass.

## Carry diagnostics as a typed error instead of a formatted string #dev-ready

Source: code audit 2026-11-15. Output text stays byte-identical.

### Current behavior

`jaiphError` in `src/errors.ts` returns `new Error("file:line:col CODE msg")`. `diagnosticFromThrown` in `src/diagnostics.ts` (near line 48) recovers the fields with `/^(.+):(\d+):(\d+) (\S+) ([\s\S]+)$/`. `code` is typed `string`; there are about 30 distinct `E_*` codes and no central list. A message or path that contains text shaped like `:1:2 X ` can be mis-split.

### Required behavior

- `class JaiphError extends Error { file; line; col; code: DiagnosticCode }` with `message` exactly as today.
- `DiagnosticCode` is a string-literal union in `src/errors.ts` listing every code in use.
- `diagnosticFromThrown` uses `instanceof JaiphError` and no regex. A non-Jaiph error keeps today's fallback.
- `jaiph compile --json` output is unchanged.

### Acceptance

- `test-fixtures/compiler-txtar/parse-errors-snapshot.json` and the other compiler snapshots are unchanged.
- Test: a file path containing `:3:4 E_FAKE ` still yields the right file, line, column and code.
- A test that every `E_*` literal in `src/` (outside tests) is a member of `DiagnosticCode`.
- `npm test`, `npm run lint` pass.

## Remove bash-runtime leftovers and dead exports; stop shipping tests in dist #dev-ready

Source: code audit 2026-11-15.

### Current behavior

Stale code from the old bash runtime:

- `isInternalParamValue` matching `::impl`, `jaiph::execute_readonly`, `jaiph::prompt_impl` (`src/cli/shared/format-params.ts` lines 9–15) and `stepFunc: "jaiph::prompt"` (`src/cli/run/progress.ts` near line 109)
- deletions of `JAIPH_STDLIB`, `JAIPH_LIB`, `JAIPH_PRECEDING_FILES`, `BASH_ENV`, and a comment about an emitted `export JAIPH_SCRIPTS=…` (`src/cli/run/env.ts` lines 74–93)
- a stand-alone `main()` with `readStdin` in `src/runtime/kernel/prompt.ts` (lines 172–199) and a `require.main` block in `src/runtime/kernel/node-workflow-runner.ts` (lines 68–75); nothing invokes either
- `toImportSource` rewriting `.jh` to `.sh` (`src/transpile/resolve.ts` lines 19–20), used only by tests

Dead or misplaced:

- `JaiphTestModule` (`src/types.ts` near line 401) and `RuntimeModuleNode` (`src/runtime/kernel/graph.ts`): no importer
- `lookupDef`, `lookupScript`, `extractRunMeta` (`src/cli/shared/errors.ts`) and `formatParamsForDisplay`: used only by tests
- `HookEventName`, `HookConfig`, `HookPayload` live in layer-0 `src/types.ts` (lines 406–453) but are used only by `src/cli/run/hooks.ts` and `emitter.ts`
- `src/cli/commands/minisign-fixture.ts` is a test fixture in the production tree
- `src/config.ts` is outside every dependency-cruiser layer rule: it imports `./parser` and is imported by runtime and CLI, and has no row in `docs/agent-analyzability.md`

Build: the `build` script copies `src/runtime` into `dist/src/runtime`, a tree that is now all TypeScript. `dist/src/runtime/kernel` contains 58 `.ts` files, 32 of them tests, and `package.json` ships `dist/src/`.

### Required behavior

- Delete the stale code and the dead symbols above. Before deleting each env-var cleanup in `env.ts`, confirm nothing in `src/`, `runtime/`, `e2e/` or `docs/env-vars.md` still refers to it (there is a docs parity gate: `env.JAIPH_X` text under `src/` must match a `docs/env-vars.md` row).
- Symbols used only by tests: delete them with their tests if they pin nothing a user can observe; otherwise keep them and say why in the report.
- Move the hook types next to `src/cli/run/hooks.ts`. Move `minisign-fixture.ts` under `test-infra/` or a `*.test-fixture.ts` location excluded from the package.
- Add a dependency-cruiser rule and a docs row for `src/config.ts` (allowed imports: layer 0 and `src/parser.ts`), with a synthetic-violation case in `src/arch-check.test.ts`.
- The published package contains no `.ts` sources and no test files. Fix the build copy step or the `files` list.

### Acceptance

- `npm pack --dry-run` output (assert in a test or script under `scripts/`) lists no `*.test.js`, no `*.ts` except `*.d.ts`.
- `npm run arch:check` passes with the new `config.ts` rule; the synthetic violation fails.
- `tsc`, `npm test`, `npm run lint`, `scripts/build-registry.test.mjs`, the standalone-binary / release smoke tests in CI config, and `bash e2e/test_all.sh` pass.
- CHANGELOG entry under Unreleased.
