# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Add `else` branch to `if` #dev-ready

**Context.** `if var == "value" { … }` exists in workflows and rules, but there is no `else`. The documented workaround is `match`, which forces a wildcard arm and value-shaped bodies, or abusing `catch` blocks. This is the single biggest ergonomic gap agents hit when authoring workflows. Parser entry: `src/parse/` (the `if` handler in the `STATEMENT` dispatch table in `src/parse/workflow-brace.ts`); step validation: `src/transpile/validate-step.ts`; runtime: the `if` case in `src/runtime/kernel/node-workflow-runtime.ts`; formatter: `src/format/emit.ts`.

**Change.** Support:

```jaiph
if status == "ok" {
  log "healthy"
} else {
  logerr "unhealthy: ${status}"
}
```

Rules: `else` must appear on the same line as the closing `}` of the `if` block (`} else {`), takes a brace block of the same step forms allowed in the surrounding body (workflow vs rule constraints apply identically), no `else if` chaining in this task (a bare `else` containing a nested `if` is fine). `if`/`else` remains a statement (no value production).

**Acceptance criteria.**
- txtar fixtures in `test-fixtures/compiler-txtar/valid.txt`: `if/else` in a workflow and in a rule compile.
- txtar fixtures in `parse-errors.txt`: `else` on its own line without `}`, `else` without a preceding `if`, and `else if (`chaining`)` each produce `E_PARSE` with a fix hint.
- Golden AST fixture + expected JSON for an `if/else` statement (`test-fixtures/golden-ast/`).
- Runtime e2e test: both branches execute correctly (true → then-block only, false → else-block only), in a workflow and in a rule.
- Rule-scope validation still rejects forbidden steps (e.g. `prompt`) inside an `else` block in a rule — covered by a txtar case.
- `jaiph format` is idempotent on `if/else` (formatter test), emitting canonical `} else {`.
- `docs/grammar.md` (`if` section + EBNF), `docs/language.md`, and `docs/jaiph-skill.md` updated (remove "no else" claims).

## Allow `catch` / `recover` on inline-script `run` steps #dev-ready

**Context.** Named-ref calls support failure handling (`run deploy() catch (err) { … }`, `run deploy() recover (err) { … }`), but inline scripts do not: `` run `test -z "$(git status --porcelain)"`() catch (err) { … } `` fails with `E_PARSE unexpected content after anonymous inline script: 'catch (err) {'`. Authors are forced to declare a named `script` solely to attach failure handling to a one-liner. The grammar EBNF in `docs/grammar.md` shows `run_catch_stmt = "run" call_ref "catch" …` (call_ref only); the inline-script parse path rejects any trailing tokens after the closing `)`.

**Change.** Extend the inline-script `run` parse path (single-backtick and fenced forms) to accept the same optional `catch (name) <body>` / `recover (name) <body>` suffixes as named-ref `run`, with identical semantics (catch = once, recover = retry loop honoring `run.recover_limit`, mutually exclusive). Runtime: inline scripts already execute through the same managed-subprocess path as named scripts, so the catch/recover machinery should be reusable. Keep the existing restriction that `run async` does not combine with inline scripts.

**Acceptance criteria.**
- txtar `valid.txt` cases: inline script + `catch` block, inline script + `recover` block, in both workflow and rule bodies.
- Runtime e2e: a failing inline script's `catch` body runs once with the merged output bound; a failing inline script under `recover` retries until a counter-file-based repair makes it pass.
- `recover` + `catch` together on one inline step is rejected (same error as named refs) — txtar case.
- `docs/grammar.md` EBNF (`run_catch_stmt` / `run_recover_stmt` / `inline_script`) and the Inline Scripts restriction list updated; `docs/jaiph-skill.md` inline-script section updated (remove the "no catch/recover on inline scripts" caveat).

## Allow dot-notation subjects in `if` and `match` #dev-ready

**Context.** Typed prompt captures expose fields via dot notation (`${r.verdict}`) in strings, but `if` and `match` subjects must be plain identifiers: `if r.verdict == "reject" { … }` fails with `E_PARSE invalid if syntax; expected: if <identifier> <op> <operand> …`. The workaround (`const verdict = "${r.verdict}"` then `if verdict == …`) is boilerplate on the most common typed-prompt pattern: ask for a verdict, branch on it.

**Change.** Accept `IDENT.IDENT` as the subject of `if` and `match` statements/expressions when the base identifier is a typed prompt capture and the field exists in its `returns` schema — the same compile-time validation already implemented for `${var.field}` interpolation (see dot-notation validation in `src/transpile/`). Runtime resolves the field value exactly as interpolation does. Plain unknown `a.b` subjects (not a typed capture, or unknown field) get the existing dot-notation `E_VALIDATE` errors, not a parse error.

**Acceptance criteria.**
- txtar `valid.txt`: `if r.verdict == "ok" { … }` and `const x = match r.verdict { … }` compile when `r` is a typed prompt capture with a `verdict` field.
- txtar `validate-errors.txt`: dot subject on a non-typed-capture variable and on an unknown field produce the same `E_VALIDATE` messages as the interpolation path.
- Runtime e2e (with `mock prompt` JSON): both `if` branches and `match` arms select correctly based on the field value.
- Golden AST fixture for an `if` with a dot-notation subject.
- `docs/grammar.md` (`if`, `match`, EBNF subject productions) and `docs/jaiph-skill.md` (control-flow bullet about rebinding dot fields) updated.

## Per-subcommand `-h` / `--help` #dev-ready

**Context.** Only `jaiph compile -h` prints command usage; `jaiph run --help`, `jaiph test --help`, `jaiph format --help`, `jaiph install --help` are parsed as file paths or ignored tokens and produce confusing errors (`src/cli/index.ts` recognizes `-h`/`--help` only as the first token after `jaiph`). `docs/cli.md` ("Global options") documents this limitation instead of fixing it.

**Change.** Every subcommand (`run`, `test`, `compile`, `format`, `init`, `install`, `use`) recognizes `-h` / `--help` anywhere in its argument list **before positional processing**, prints its own usage block (flags + one example) to stdout, and exits 0. Keep `jaiph --help` as the overview. Put each usage string next to its command implementation in `src/cli/commands/*.ts` so it stays in sync.

**Acceptance criteria.**
- Integration test iterating all seven subcommands: `jaiph <cmd> --help` and `jaiph <cmd> -h` exit 0 and stdout contains the subcommand name and the word `Usage`.
- `jaiph run --help` no longer attempts to resolve `--help` as a file.
- `jaiph --help` and bare `jaiph` behavior unchanged (existing tests).
- `docs/cli.md` "Global options" paragraph rewritten to state per-command help exists.

## `jaiph test` discovery with zero tests should not fail #dev-ready

**Context.** `jaiph test` (no args) and `jaiph test <dir>` exit **1** with `jaiph test: no *.test.jh files found` when discovery matches nothing (`src/cli/commands/test.ts:25,43`). This forces every CI pipeline and agent loop to guard the call ("run jaiph test only if test files exist"), and the bootstrap skill doc has to carry a warning about it.

**Change.** In **discovery mode** (no path, or a directory path), zero matches prints `jaiph test: no *.test.jh files found (nothing to do)` to stderr and exits **0**. Passing an explicit **file** path that does not exist or is not a `*.test.jh` file remains an error (exit 1) — a named target must exist.

**Acceptance criteria.**
- Test: `jaiph test` in a workspace without any `*.test.jh` exits 0 and prints the notice.
- Test: `jaiph test <dir>` where the dir exists but has no test files exits 0.
- Test: `jaiph test missing.test.jh` (nonexistent file) exits 1.
- Existing behavior for found-and-failing tests unchanged (exit non-zero).
- `docs/cli.md` and `docs/testing.md` updated; remove the "skip jaiph test if there are no test files" caveat from `docs/jaiph-skill.md` ("Your authoring loop" and the final commands block).

## Reject mixing `mock prompt { … }` with queued `mock prompt "…"` #dev-ready

**Context.** In a `*.test.jh` test block, when a pattern-dispatch `mock prompt { … }` block is present, all queue-style `mock prompt "…"` / `mock prompt <const>` lines in the same block are **silently ignored** (`docs/testing.md` "Limitations" documents this). Silently ignoring authored mocks makes tests pass for the wrong reason.

**Change.** Make the combination a compile-time error for the test file: when a single `test` block contains both a `mock prompt { … }` block and at least one queue-style `mock prompt` entry, fail with `E_PARSE` (or `E_VALIDATE`, matching how other test-block shape errors are reported) and a message like: `cannot mix "mock prompt { … }" with queued "mock prompt …" in one test block; choose one style`. Implementation likely lives where test blocks are parsed/validated (`parseTestBlock` and/or the test-file validation path; see `src/runtime/kernel/node-test-runner.ts` and the parser for test blocks).

**Acceptance criteria.**
- txtar fixture (or parser unit test) with a `.test.jh` file mixing both styles in one block fails with the new message; the same styles in **separate** test blocks of one file still pass.
- `jaiph compile path/to/file.test.jh` surfaces the error (test files are validated when passed explicitly).
- `docs/testing.md`: replace the "Do not combine…ignored" limitation bullets with the new error behavior.

## Formatter must not strip quotes from top-level `const` string values #dev-ready

**Context.** `jaiph format` rewrites a top-level `const x = ".jaiph/tmp/x.md"` to the unquoted bare-token form `const x = .jaiph/tmp/x.md` — but only when the value contains no spaces; values with spaces keep their quotes. The result is value-preserving and idempotent (verified), but the formatter silently changes the author's chosen delimiter and produces inconsistent output within one file (quoted and unquoted consts side by side, depending on whether the value happens to contain a space). A formatter should canonicalize to one stable form, not toggle forms based on value content. Reproduce: write a file with `const p = "some/path with space.md"` and `const q = ".jaiph/tmp/x.md"`, run `jaiph format` — `p` stays quoted, `q` loses its quotes. Top-level `const` emission lives in `src/format/emit.ts` (envDecls path); the parser is in `src/parser.ts` / `src/parse/`.

**Change.** Canonical rule: a top-level `const` value written as a **double-quoted string** in the source is emitted **double-quoted**, always — regardless of spaces. Values written as **bare tokens** (e.g. `const MAX = 3`) stay bare. If the AST currently discards the was-quoted distinction, extend the env-decl AST node to retain it (and update golden AST fixtures accordingly). The same rule should hold for `"""…"""` values (already emitted verbatim).

**Acceptance criteria.**
- Formatter unit test: a quoted no-space value (`const q = ".jaiph/tmp/x.md"`) survives `jaiph format` with quotes intact; a quoted value with spaces also survives; a bare numeric token stays bare.
- Idempotency test: formatting twice produces identical output for all three cases.
- `jaiph compile` accepts the formatted output and `${q}` interpolation yields the same value as before formatting (runtime or kernel test).
- Golden AST fixtures regenerated only if the AST shape changed, with the diff reviewed and explained in the commit message.
- Existing `.jh` files in the repo reformatted with the fixed formatter (`jaiph format` over `.jaiph/*.jh`, `examples/`, `e2e/` fixtures that are format-clean today) — committed alongside, so `--check` stays green.

## Error-message quality pass: async handles, Docker timeout, empty stderr #dev-ready

**Context.** Three runtime errors give users nothing to act on:
1. `src/runtime/kernel/node-workflow-runtime.ts:110` — unknown async handle returns `error: "invalid handle"` with no handle id or hint.
2. `src/cli/commands/run.ts` (~line 190) — Docker timeout appends literally `E_TIMEOUT container execution exceeded timeout` with no duration or remedy.
3. `src/cli/shared/errors.ts:26` — `summarizeError()` falls back to `"Workflow execution failed."` when stderr is empty, hiding where to look next.

**Change.**
1. → `invalid async handle "${handleId}" — the handle was never created or was already consumed`.
2. → `` `E_TIMEOUT container execution exceeded ${activeDockerConfig.timeoutSeconds}s — increase runtime.docker_timeout_seconds or JAIPH_DOCKER_TIMEOUT` `` (use the actual configured value).
3. → when stderr is empty and an exit code is known, `` `Workflow execution failed (exit ${code}) with no error output; inspect run_summary.jsonl and step artifacts under ${runDir}` `` (fall back to the old text only when neither code nor run dir is known).

**Acceptance criteria.**
- Unit tests assert each new message shape (handle id present; timeout seconds value present; exit code and run dir present).
- No existing e2e expectation matches the old strings (`grep -rn "invalid handle" e2e/ src/` shows only the new form; update any expectations that asserted the old text).

## Lazy-load the Docker overlay script with an actionable error #dev-ready

**Context.** `src/runtime/docker.ts:287` reads `overlay-run.sh` with `readFileSync` at **module load time**. Importing the docker module — which happens for every CLI invocation that might touch Docker — crashes with a raw ENOENT stack trace if the file is missing from the installation, even for commands that never use Docker.

**Change.** Move the read into a function (`loadOverlayScript()`) called only where the script is written out (~line 301, `writeFileSync(scriptPath, OVERLAY_SCRIPT, …)`). Wrap the read in try/catch and rethrow as `E_CLI_SETUP: runtime/overlay-run.sh not found at <path> — the Jaiph installation is incomplete; reinstall with "jaiph use <version>"`. Cache the content after first successful read.

**Acceptance criteria.**
- Unit test: importing the docker module does not read `overlay-run.sh` (e.g. temporarily rename the file in a sandboxed copy, import succeeds, calling the overlay path throws the `E_CLI_SETUP` message containing the path).
- Non-Docker commands (`jaiph compile`, `jaiph format`) work even when `overlay-run.sh` is absent — covered by a test or e2e case.
- Docker e2e flow unchanged when the file exists.

## Remove dead `formatDiagnosticLine` indirection in the stderr parser #dev-ready

**Context.** `src/cli/run/stderr-handler.ts` threads a `formatDiagnosticLine: (line: string) => string` parameter through `handleLine` (line 49) and defines it as the identity function `(ln) => ln` (line 86) at the only call-site builder (`createStderrParser`, line 90). It never formats anything — pure dead indirection.

**Change.** Delete the parameter from `handleLine` and the identity function from `createStderrParser`; use `line` directly in the `emitter.emit("stderr_line", …)` call (line 78). Update all `handleLine` call sites and any tests that pass the parameter.

**Acceptance criteria.**
- `grep -rn "formatDiagnosticLine" src/` returns nothing.
- `npm test` passes; stderr passthrough behavior in run output is unchanged (existing integration tests cover this).

## Document the Docker env-var allowlist in sandboxing docs #dev-ready

**Context.** `isEnvAllowed()` (`src/runtime/docker.ts:479`) forwards only environment variables matching `ENV_ALLOW_PREFIXES` (see the constant near that function — e.g. `JAIPH_`, agent/LLM-related prefixes) into the container, excluding `JAIPH_DOCKER_*`. `docs/sandboxing.md` does not mention this filtering, so users cannot tell why their custom env vars vanish inside sandboxed runs.

**Change.** Add a "Environment forwarding" section to `docs/sandboxing.md`: list the exact allow prefixes and the `JAIPH_DOCKER_*` exclusion (read them from the constants in `src/runtime/docker.ts` — do not guess), state that all other host variables are **not** forwarded, and show the workaround (export inside a `script` body, or bake values into the image). Cross-link from `docs/configuration.md` ("Inspecting effective config at runtime") and `docs/cli.md` (Docker env var section).

**Acceptance criteria.**
- `docs/sandboxing.md` contains the new section with the prefix list matching the source constants verbatim (reviewer check: diff the doc list against `ENV_ALLOW_PREFIXES` / `ENV_ALLOW_EXCLUDE_PREFIX` in `src/runtime/docker.ts`).
- The docs-parity workflow (`.jaiph/docs_parity.jh`), if run, raises no contradiction between the section and the implementation.
- Cross-links added in the two referenced docs.
