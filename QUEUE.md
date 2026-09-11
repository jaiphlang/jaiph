# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Spawn and exec failures are failed steps; always emit STEP_END and RUN_END #dev-ready

Context: `spawnAndCapture` (`src/runtime/kernel/node-workflow-runtime.ts`) calls `_scriptSpawn.spawn(command, args, …)` inside a Promise executor with no try/catch. The `'error'` handler settles `status: 1`, but a synchronous throw from `spawn` (including `E2BIG` when argv + env exceed `ARG_MAX`) rejects the Promise. `executeManagedStep` awaits `fn(stepIo)` and only `finally`-stops the idle watchdog; on throw it never writes `STEP_END`. `runRoot` awaits `executeDef` then emits `RUN_END`; on throw it never emits `RUN_END`. `runWorkflowRunner` (`.catch` in `src/runtime/kernel/node-workflow-runner.ts`) prints `jaiph node runner: …` and `process.exit(1)` with no journal close. Observed: `STEP_START` for the oversized script, empty `.out`/`.err`, no `STEP_END`, no `RUN_END`, heartbeat stops. `recover_limit` never applies because recover never sees a failed step.

Problem: `run save_string_to_file(path, big)` after a large script failure (CI log ≳ 1 MB on macOS) aborts the jaiph process instead of failing the step. From outside the run vanished; the child never started.

Remediation — implement exactly this:

1. Wrap `spawn` in `spawnAndCapture` so a synchronous throw settles the same way as the `'error'` event: `status: 1`, stderr text, Promise resolves (never rejects).
2. Map `E2BIG` (throw or `'error'`) to a stable diagnostic on stderr: `E_ARGV_TOO_LARGE: <byte-count> bytes (ARG_MAX …)` (include the attempted argv+env size). Other spawn failures stay `status: 1` with `errText` (keep the existing ENOENT-interpreter message).
3. `executeManagedStep`: if `fn` throws, convert to `StepResult` `{ status: 1, output: "", error: <message> }` and still write capture files + `STEP_END`. `result` must always be defined before emit.
4. `runRoot`: emit `RUN_END` and stop the heartbeat in a `finally`, including when `executeDef` throws. A vanished process is not a handleable error.
5. Do not add a new language form. Do not change recover binding contents.

### Acceptance criteria

- Unit test (spawn seam `_scriptSpawn`): `spawn` throwing `E2BIG` resolves the script step as `status: 1`; stderr matches `E_ARGV_TOO_LARGE` and includes a byte count; the Promise does not reject.
- Unit test: `spawn` emitting `'error'` with `code: "E2BIG"` is the same failed-step contract (not a thrown run).
- Unit test: `executeManagedStep` / `runRoot` still emit `STEP_END` (status 1) and `RUN_END` when the inner `fn` throws a generic `Error`. Today's control flow (no `STEP_END` / `RUN_END` on throw) must fail this test.
- A `run script(huge)` whose argv would exceed `ARG_MAX` does not reject `runRoot`. After the step, `run_summary.jsonl` contains `STEP_END` for that script and a terminal `RUN_END`. Prefer the spawn mock; a live ≳1 MB argv is optional and must not be the only coverage.
- `recover` on a later step still runs when the oversized spawn is itself the failed `run` (the step ends `status: 1`, so `recover_limit` applies). Add a runtime or e2e test that proves recover body runs after a mocked `E2BIG`.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## recover and catch bind the failed step capture path, not the output bytes #dev-ready

Context: `runRecoverBody` (`src/runtime/kernel/node-workflow-runtime.ts`) sets the recover/catch binding to `` `${lastResult.output}${lastResult.error}` `` — the full merged stdout+stderr string. Docs (`docs/language.md` § catch/recover, `docs/jaiph-skill.md`, `docs/grammar.md`) say the same. The failed step already has those bytes on disk: `executeManagedStep` writes `JAIPH_RUN_DIR/NNNNNN-<kind>__<name>.out` and `.err` incrementally, then rewrites them at `STEP_END`. Call sites such as `.jaiph/ensure_ci_passes.jh` then pass that string into a script as argv (`save_string_to_file(path, failure)`), which hits `ARG_MAX` on a ~1 MB+ CI log. `run foo() > file` is `E_PARSE` (`src/parse/core.ts`); there is no `capture_to` form. Leave that ban in place.

Problem: the recover binding duplicates a file the runtime already wrote, then forces the next script to put those bytes on `execve`. The prompt already tells the agent to read a file. The binding should be that file's path.

Remediation — implement exactly this (breaking):

1. `catch (name)` and `recover (name)` bind `name` to the **absolute path** of the failed step's stdout capture (`out_file` / `NNNNNN-*.out` under `JAIPH_RUN_DIR`). Stderr stays in the sibling `.err` (same seq prefix). Do not concatenate stdout+stderr into the binding and do not copy the capture to a second file unless a test needs a merged witness — prefer `cp`/`cat` in the test script from the bound path.
2. Plumb `outFile` (and `errFile` if needed) on `StepResult` from `executeManagedStep` so every `run` target that can carry `catch`/`recover` (named script, inline script, def, async branch) supplies a real path. A spawn that produced no stdout still binds the `.out` path (file exists; may be empty). Spawn diagnostics live in `.err`.
3. Update docs to state the binding is a path: `docs/language.md` (catch and recover), `docs/jaiph-skill.md` (Failure handling), `docs/grammar.md` if it claims "merged stdout+stderr". Examples that interpolate `${err}` as log *content* should treat it as a path (`logerr "failed; see ${err}"` is fine).
4. Update in-repo callers that treat the binding as content: `e2e/tests/101_ensure_recover_output_contract.sh` (and any sibling that `printf`s `$1` as the payload), `.jaiph/ensure_ci_passes.jh` if it still forwards the binding to a script. `.jaiph/gh_ci_passes.jh` `log "… ${failure}"` becomes a path line — acceptable. `examples/recover_loop.jh` does not use the binding as content.
5. Do not add `run foo() > file` or `capture_to`. Do not add a stdin clause in this task.

### Acceptance criteria

- Runtime test: `run failing_script() catch (failure) { … }` binds `failure` to an absolute path; `readFileSync(failure)` equals the script's stdout; sibling `.err` equals stderr. Today's "binding === Hello\\nOops" content contract must fail and be rewritten.
- Runtime or e2e: a script whose stdout is > 1 MB fails; the recover/catch binding is a path whose file size matches that stdout; no recover-body script receives the bytes as argv.
- `e2e/tests/101_ensure_recover_output_contract.sh` (and `102_engineer_recover_contract.sh` if it assumes content) assert path + file contents, not the binding string itself being the log.
- Docs listed above say the binding is the capture path, not merged stdout+stderr text.
- `npm run build`, `npm test`, and `npm run test:e2e` pass.

## Scripts accept a large payload on stdin; save_string_to_file reads stdin #dev-ready

Context: Script arguments are argv only (`$1` / `sys.argv`). That is the documented contract (`docs/jaiph-skill.md`, `docs/language.md`). `run foo() > file` is `E_PARSE`. `.jaiph/lib_common.jh` `save_string_to_file` already documents that content travels through argv and is subject to `ARG_MAX` (~1 MB on macOS). `spawnAndCapture` uses `stdio: ["ignore", "pipe", "pipe"]` — stdin is discarded. Recover path-binding does not help `run process(huge_json)` or any other large string that is not already a capture file.

Problem: any `run script(big)` whose encoded argv + env exceeds the OS limit fails at `execve`. There is no supported way to hand a large string to a script.

Remediation — implement exactly this:

1. Language: optional `stdin <expr>` on a standalone `run` of a **script** (named or inline), after `()` and before `catch` / `recover`:

   `run save_string_to_file(path) stdin content`

   `stdin` is rejected (`E_PARSE` / `E_VALIDATE`) on `run` of a def, on `run async`, and on `run` without a script target. `<expr>` is a normal string expr (bare ident, quoted, interpolation). Trailing `>` / `>>` / `|` / `&` stay `E_PARSE`.
2. Runtime: spawn that step with stdin piped; write the evaluated expr bytes (UTF-8) to the child's stdin and end the stream. Those bytes must not appear in argv. `spawnAndCapture` grows a stdin parameter; default remains `ignore` when the clause is absent.
3. Change `.jaiph/lib_common.jh` `save_string_to_file` to `path = sys.argv[1]; content = sys.stdin.read()`. Update every in-repo call to `run common.save_string_to_file(path) stdin content` (`.jaiph/architect_review.jh` and any other caller). Comment the new contract; drop the ARG_MAX warning for this helper.
4. Docs: `docs/language.md` (`run` / scripts), `docs/jaiph-skill.md` (arguments), `docs/grammar.md` (`run_stmt`). Editor grammars (VS Code TextMate, Zed/Tree-sitter) must highlight `stdin` as a `run` clause, not as a shell redirect.
5. Keep argv as the default small-arg channel. Do not auto-promote large argv to stdin.

### Acceptance criteria

- Parse/validate tests: `run foo(a) stdin body` is accepted when `foo` is a script; `run someDef() stdin x` is `E_VALIDATE` (or `E_PARSE` if you reject earlier); `run foo() > file` remains `E_PARSE`; `run async foo() stdin x` is rejected.
- Runtime test: `run echo_stdin() stdin payload` with `script echo_stdin = \`cat\`` returns `payload`; spawn argv does not contain `payload` (assert via `_scriptSpawn` spy).
- Runtime test: a stdin payload larger than 1 MB is written in full and the step exits 0. Today's argv path cannot pass this.
- `save_string_to_file` / architect_review call sites compile under the new helper contract (path argv + stdin body).
- Formatter round-trips `run name(args) stdin expr`.
- `npm run build`, `npm test`, `npm run test:e2e`, and editor grammar tests (`plugins/vscode`, `plugins/zed` as already wired) pass.

## jaiph format is a no-op on shebang + const = prompt triple-quoted def #dev-ready

Context: `jaiph format` (`src/cli/commands/format.ts`) parses with trivia and re-emits via `emitModule` (`src/format/emit.ts`, `src/format/emit-steps.ts`). A `const name = prompt """ … """` step is a `const` whose RHS is `Expr.prompt`. Trivia on that expr carries `bodyKind: "triple_quoted"` and `rawBody` (author lines, including margin). Docs already state the contract: `docs/cli.md` (`jaiph format`) — shebang preserved, triple-quoted prompt blocks emit verbatim (author margin via trivia), a single blank line between steps is kept. `examples/say_hello.jh` uses this shape and `e2e/tests/128_examples_format_check.sh` checks every example, but no unit test pins the minimal file below. `src/format/emit.test.ts` has `const = prompt "…"` and top-level `const x = """`, not `const = prompt """` with a shebang.

Problem: this exact source is a normal first-agent file. Format must leave it bit-for-bit unchanged (default `--indent 2`). A rewrite that collapses `"""` to `"…"`, re-indents the prompt body, moves the closing `"""`, drops the shebang, or drops the blank line before `return` is a contract break. Today's suite can stay green while that happens.

Source that must be a no-op (trailing newline after `}`):

```
#!/usr/bin/env jaiph

export def hello(name) {
  const response = prompt """
    Say hello to ${name} and provide a fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}
```

Remediation — implement exactly this:

1. Add a unit test in `src/format/emit.test.ts`: `emitModule` of the def body (same steps, no shebang — shebang is CLI-only) equals the input bit-for-bit, including the 4-space prompt margin, the closing `"""` at 2 spaces, and the blank line before `return`.
2. Add a CLI / e2e check (`e2e/tests/100_format_command.sh` or a sibling): write the full source above (with shebang) and assert `jaiph format --check` exits 0 and `jaiph format` does not change the bytes. A second format pass is also a no-op.
3. If format currently rewrites this source, stop the rewrite. Do not collapse the prompt to a double-quoted string. Do not change `rawBody` / prompt trivia, recover bindings, or `stdin` in this task.

### Acceptance criteria

- Unit test: the `export def hello(name) { … }` body above (no shebang) round-trips through `parsejaiphWithTrivia` + `emitModule` with `assert.equal` to the original string. A formatter that emits `prompt "Say hello…"` or re-indents the two body lines must fail this test.
- `jaiph format --check` on a file whose entire contents are the shebang source above exits 0. `jaiph format` on a copy leaves `cmp` equal.
- `${name}` stays as authored interpolation in the formatted file (not substituted, not escaped away).
- `npm run build` and `npm test` pass. If you add the e2e section, `npm run test:e2e` passes that file.
