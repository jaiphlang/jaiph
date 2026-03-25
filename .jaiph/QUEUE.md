# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Fix upgrade workflow CI recovery wiring and failure artifact reporting <!-- dev-ready -->

**Goal.** Make `.jaiph/upgrade.jh` reliably run the CI recovery loop and report the true failing step output, instead of failing once with confusing artifacts.

**Problem observed.**

- `workflow default` calls `ensure ci_passes "$repo_dir"` directly, so `workflow ensure_ci_passes` recover flow is bypassed.
- Inside `ensure_ci_passes`, `ensure ci_passes recover { ... }` does not pass `"$repo_dir"` to `ci_passes`.
- Recover prompt says failure output is saved to `ci_log_file`, but the workflow does not write `$1` there.
- Failure summary can point to an unrelated `err` file when the true failure output is in a different step's `.out`.

**Scope.**

1. **Upgrade workflow wiring.**
   - In `default`, call `run ensure_ci_passes "$repo_dir"` instead of directly ensuring `ci_passes`.
   - In `ensure_ci_passes`, pass `"$repo_dir"` to `ensure ci_passes`.
2. **Recover payload handling.**
   - In recover block, persist `$1` into `ci_log_file` before prompting.
   - Assert log file is non-empty before prompting.
3. **Failure artifact selection.**
   - Runtime/reporting should display the failed step's own artifact path/content (prefer actual failing step output) rather than a stale prior-step `err` file.
4. **Tests.**
   - Add regression test for upgrade flow: failing CI triggers recover with repo arg and non-empty saved failure payload.
   - Add reporting test: summary "Output of failed step" maps to the true failed step artifact.

**Acceptance criteria.**

- `upgrade.jh` uses `ensure_ci_passes` as the recovery entrypoint.
- Recover receives current failed-rule output and saves it to `ci_log_file`.
- Prompt instruction about `ci_log_file` matches actual behavior.
- Failure summary points to the real failed step output artifact.
- Regression tests cover this flow and pass.

---

## Add shebang support and separate file transpilation <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 3b, 3c, 3d.

**Goal.** Scripts transpile to standalone executable files with `+x` permission. Users can provide a custom shebang (e.g. `#!/usr/bin/env node`) as the first line of the script body; otherwise `#!/usr/bin/env bash` is used.

**Scope.**

1. **AST**: add `shebang?: string` field to `ScriptDef`.
2. **Parser**: check first non-empty line of script body for `#!`. If present, store in `shebang` and exclude from body commands.
3. **Keyword guard**: for bash scripts (no shebang or `#!/usr/bin/env bash` shebang), keep Jaiph keyword rejection. For custom shebangs, skip the guard.
4. **Emit**: change `emitWorkflow` return type to `{ module: string; scripts: Array<{ name: string; content: string }> }`. Script file content = shebang line + body.
5. **Build**: `build.ts` writes each script to `build/scripts/<name>`, sets `chmod +x`. Module `.sh` calls scripts via `"$JAIPH_SCRIPTS/<name>" "$@"`.
6. **Runtime**: set `$JAIPH_SCRIPTS` env var in lifecycle/stdlib to point to build scripts directory.
7. **E2e test**: add test with a custom shebang script (e.g. `#!/usr/bin/env node` or `#!/usr/bin/env python3`) that validates the polyglot model works end-to-end.

**Acceptance criteria.**

- Scripts emit as separate files under `build/scripts/` with `+x`.
- Default shebang is `#!/usr/bin/env bash` when none specified.
- Custom shebang (e.g. `#!/usr/bin/env node`) is correctly placed in the output file.
- Jaiph keyword guard is skipped for non-bash shebangs.
- Module `.sh` correctly invokes scripts by path.
- `$JAIPH_SCRIPTS` is set at runtime.
- E2e test with custom shebang script passes.
- All existing tests pass.

---

## Implement script isolation and shared library support <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Implementation Plan Phase 4.

**Goal.** Scripts execute in full isolation — only positional arguments, no inherited variables. Shared utility code is loaded via `$JAIPH_LIB`.

**Scope.**

1. **Script isolation.** With separate-file transpilation (previous task), isolation is largely inherent — scripts run as separate processes via `exec`. Verify that no environment variables leak from the calling module beyond `$JAIPH_LIB` and `$JAIPH_SCRIPTS`. If needed, wrap calls with `env -i` or equivalent.
2. **`$JAIPH_LIB` runtime support.** The runtime sets `$JAIPH_LIB` to the project's shared library path (e.g. `.jaiph/lib/` relative to workspace root) before script execution. Bash scripts can `source "$JAIPH_LIB/utils.sh"`.
3. **Validate no cross-script calls.** Parser or validator: detect when a script body references another Jaiph script by its transpiled name. Emit error: `"scripts cannot call other Jaiph scripts; use a shared library or compose in a workflow"`.
4. **Verify `.jaiph/lib/` shared libraries work end-to-end.** The shared libraries (`checks.sh`, `strings.sh`) must be loadable from scripts and work correctly under isolation.

**Acceptance criteria.**

- Scripts cannot access parent scope variables (test: script that tries to read a `const` from the calling workflow gets empty string or error).
- `$JAIPH_LIB` is set correctly during script execution.
- `source "$JAIPH_LIB/..."` works from within isolated scripts.
- Cross-script call detection works (parser/validator error on reference to another Jaiph script).
- All existing tests still pass.
- E2e test added: script isolation verified (script cannot read caller variables).

---

## Recover payload contract: failed rule output (stdout+stderr) <!-- dev-ready -->

**Goal.** Make `ensure <rule> recover { ... }` use one fixed contract: `$1` is the full combined stdout+stderr produced by the failed rule execution, including nested scripts/rules/workflows executed within that rule call.

**Scope.**

1. **Runtime contract source.** Ensure runtime captures the failed rule execution output as one merged payload stream that preserves practical ordering.
2. **Recover wiring.** In transpiled recover loop, set recover argument (`$1`) to that merged failed-rule payload for each retry attempt.
3. **No alternative modes.** Do not add flags/config/parameters for payload source, truncation, or precedence.
4. **Docs update.** Update grammar/docs to state this exact contract in present tense.

**E2e examples that must be covered.**

1. **Simple script failure through rule.**
   - `script simple_echo { echo "Hello"; echo "Oops" >&2; exit 1 }`
   - `rule simple_echo_rule { run simple_echo }`
   - `workflow default { ensure simple_echo_rule recover { log "Error: $1" } }`
   - Assert recover log contains both `Hello` and `Oops`.

2. **Nested rule + script failure aggregation.**
   - `rule inner { run failing_script }`
   - `rule outer { log "outer start"; ensure inner }`
   - `workflow default { ensure outer recover { run save_string_to_file "$1" "recover.log" } }`
   - Assert `recover.log` contains `outer start` plus nested script stderr/stdout from `failing_script`.

3. **CI-style failure payload for prompt loop (`ensure_ci_passes` shape).**
   - `rule ci_passes { run npm_run_test_ci }` where script fails with multi-line test output.
   - Recover writes `$1` into file and validates non-empty before `prompt`.
   - Assert saved file contains representative CI failure lines and is non-empty.

4. **Retry payload updates per attempt.**
   - First attempt fails with output `attempt-1`; recover mutates state; second attempt fails with `attempt-2`.
   - Assert each recover iteration receives the current attempt output (not stale payload from previous attempt).

5. **No false payload on success.**
   - Rule eventually passes; recover block is not executed.
   - Assert no recover payload writes/logs are emitted.

**Acceptance criteria.**

- For `ensure rule recover`, `$1` is always the merged stdout+stderr from the failed rule invocation that triggered recover.
- Payload includes nested step output emitted during that failed rule invocation.
- Contract is deterministic and documented; no user-facing tuning knobs introduced.
- New/updated e2e tests pass with existing suite.

---

## Inline construct interpolation: `${run ref}` and `${ensure ref}` in strings <!-- dev-ready -->

**Goal.** Allow `run` and `ensure` calls inline inside `${}` interpolation in orchestration strings, eliminating the need for a temporary `const` when the result is only used once.

**Before:**
```
const branch = run git.current_branch
log "Deploying from ${branch}"
const ci_log = "${ci_log_dir}/ensure_ci_passes_${repo_dir}.last.log"
```

**After (also valid):**
```
log "Deploying from ${run git.current_branch}"
const ci_log = "${ci_log_dir}/ensure_ci_passes_${repo_dir}.last.log"
```

Both `$var` and `${var}` remain valid for variable interpolation. `${}` is additionally required when embedding construct calls.

**Syntax.**

```
${run <ref> [args]}        # inline run capture — stdout becomes the interpolated value
${ensure <ref> [args]}     # inline ensure capture — stdout becomes the interpolated value
${var}                     # variable lookup (existing)
$var                       # variable lookup shorthand (existing, keep)
```

**Constraints.**

- Only `run` and `ensure` are allowed inline. `prompt` is excluded (heavyweight, deserves its own step).
- No nesting: `${run foo "${run bar}"}` is a parser error. Use `const` for composition.
- Failure in `${run ref}` or `${ensure ref}` fails the enclosing step (same semantics as standalone `run`/`ensure`).
- Allowed in: `const` RHS expressions, `log`, `logerr`, `fail`, `return`, `send` RHS.
- Not allowed in: `prompt` text (prompt interpolation is handled by the runtime, not the transpiler).

**Scope.**

1. **Parser**: detect `${run ...}` and `${ensure ...}` inside string literals in orchestration constructs. Produce new AST nodes or annotate existing string expressions with embedded captures.
2. **Validator**: validate refs inside inline interpolations using the same rules as standalone `run`/`ensure` (kind checks, import resolution).
3. **Transpiler**: emit `$(symbol::ref "$@")` for inline `${run ref}` and `$(symbol::ref "$@")` for `${ensure ref}` within the enclosing bash string.
4. **Error messages**: clear guidance when users try `${prompt ...}` or nested `${run ... ${run ...}}`.

**Acceptance criteria.**

- `log "Value: ${run compute_x}"` works — inline run capture interpolated into log output.
- `const msg = "Branch: ${run git.current_branch}"` works — inline capture in const RHS.
- `${ensure git.is_clean}` works inline — failure propagates to enclosing step.
- `${prompt ...}` is a parser error with guidance.
- Nested `${run ... ${run ...}}` is a parser error with guidance.
- Bare `$var` and `${var}` continue to work for variable interpolation.
- Unit tests and e2e test covering inline interpolation.

---

## Dot notation for JSON field access: `${var.field}` <!-- dev-ready -->

**Goal.** Access fields from `prompt ... returns` responses using dot notation instead of underscore-joined variable names.

**Before:**
```
const response = prompt "..." returns '{ message: string, severity: string }'
log "Message: ${response_message}, Severity: ${response_severity}"
```

**After:**
```
const response = prompt "..." returns '{ message: string, severity: string }'
log "Message: ${response.message}, Severity: ${response.severity}"
```

Dot notation makes the field relationship explicit. `${response.message}` clearly means "field `message` of `response`" — `$response_message` is ambiguous (could be a standalone variable).

**Implementation.** This is syntactic sugar in the parser/transpiler. Bash doesn't support dots in variable names, so `${response.message}` transpiles to `${response_message}` (the existing runtime mechanism). No runtime changes needed.

**Scope.**

1. **Parser**: recognize `${identifier.field}` in string interpolation. Distinguish from import refs (import refs only appear after `run`/`ensure`, not inside `${}`).
2. **Transpiler**: emit `${identifier_field}` for `${identifier.field}` — direct mapping to the existing underscore-joined variables generated by `prompt_capture_with_schema`.
3. **Validator**: verify that `identifier` is a `const` with a `prompt_capture` RHS that has a `returns` schema containing `field`. Emit clear error if the field doesn't exist in the schema.
4. **Deprecate underscore form**: keep `$response_message` working but document `${response.message}` as the canonical form. Consider a parser warning in a future version.

**Acceptance criteria.**

- `${response.message}` works wherever `$response_message` works today.
- Validator catches typos: `${response.typo}` errors with "field 'typo' not in schema for 'response'".
- Both `${response.message}` and `$response_message` work (backward compatibility).
- Works with all schema types: string, number, boolean.
- Unit test and e2e test covering dot notation field access.

---

## Anonymous inline scripts <!-- dev-ready -->

**Goal.** Allow inline `script "body"` as a step in workflows and rules, eliminating the need to name trivial one-liner scripts.

**Before:**
```
script npm_run_test_ci() {
  npm run test:ci
}

rule ci_passes {
  run npm_run_test_ci
}
```

**After (also valid):**
```
rule ci_passes {
  script "npm run test:ci"
}
```

Anonymous scripts are syntactic sugar. The transpiler auto-generates a named script file under the hood (e.g. `_anon_ci_passes_1`). Same isolation, same shebang, same separate executable file.

**Syntax.**

```
script "single line body"
script "
  multiline
  body
"
const result = script "echo hello"
```

Custom shebang — first line of the string:
```
script "#!/usr/bin/env node
const x = JSON.parse(process.argv[2]);
process.exit(x.valid ? 0 : 1);
"
```

**Constraints.**

- Anonymous scripts follow all the same rules as named scripts: full isolation, positional args only, stdout for values, exit code for success/failure.
- Shebang detection works the same way: if the first line of the body starts with `#!`, it becomes the shebang; otherwise `#!/usr/bin/env bash` is used.
- Allowed in workflows and rules (same places where `run <script_ref>` is allowed).
- Capture supported: `const result = script "echo hello"` captures stdout.
- The auto-generated name is deterministic (derived from enclosing construct name + position) so builds are reproducible.

**Spec update.** Decision #6 changes from "Every shell operation requires a **named `script`**" to "Every shell operation runs through a `script`. Named scripts are preferred; anonymous `script "body"` is available for trivial operations."

**Scope.**

1. **AST**: add new step type `{ type: "script_inline"; body: string; shebang?: string; captureName?: string; loc: SourceLoc }`.
2. **Parser**: recognize `script "..."` (and `const x = script "..."`) as a step in workflows and rules. Extract shebang from first line if present.
3. **Transpiler**: auto-generate a named script file from the inline body. Use deterministic naming: `_anon_<construct>_<index>`. Emit the call as `"$JAIPH_SCRIPTS/_anon_..." "$@"`.
4. **Validator**: apply the same keyword guard as named scripts (bash-only guard for default shebang, skip for custom).
5. **Tests**: unit test for parsing and emission, e2e test with inline script in a rule and a workflow.

**Acceptance criteria.**

- `script "npm run test:ci"` works in rules and workflows.
- Multiline string bodies work.
- Custom shebang in anonymous scripts works.
- `const result = script "echo hello"` captures stdout.
- Auto-generated script files appear in `build/scripts/` with `+x`.
- Builds are deterministic (same input → same auto-generated names).
- All existing tests pass.

---

## Named parameters for workflows, rules, and scripts <!-- dev-ready -->

**Spec**: `.jaiph/language_redesign_spec.md` — Design Decision #16, Implementation Plan Phase 3f.

**Goal.** Replace positional `$1`/`$2` boilerplate with named parameters in construct declarations. Parameters become local variables inside the body.

**Before:**
```
workflow implement {
  const task = "$1"
  const role_name = "$2"
  const role = run select_role "$role_name"
  ...
}

script check_hash() {
  local actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ]
}
```

**After:**
```
workflow implement(task, role_name) {
  const role = run select_role "$role_name"
  ...
}

script check_hash(file_path, expected_hash) {
  local actual=$(sha256sum "$file_path" | cut -d' ' -f1)
  [ "$actual" = "$expected_hash" ]
}
```

**Scope.**

1. **AST**: add `params?: Array<{ name: string; default?: string }>` to `WorkflowDef`, `RuleDef`, `ScriptDef`.
2. **Parser**: recognize `name(param1, param2)` and `name(param1, param2 = "default")` in all three construct declarations. Parentheses are optional when there are no params — `workflow default { ... }` remains valid.
3. **Transpiler (workflows/rules)**: emit `local param1="$1"; local param2="$2"` at the top of the function body. For defaults: `local param2="${2:-default}"`.
4. **Transpiler (bash scripts)**: prepend `local param1="$1"; ...` to the generated script file. For non-bash shebangs, params are documentary only.
5. **Validator**: check call-site arity against declared params. Missing required args = validation error. Extra args beyond declared params = validation warning.
6. **Update all `.jaiph/*.jh` files** to use named params where applicable.
7. **Update all `e2e/*.jh` fixtures** to use named params.
8. **Update test fixtures and golden outputs**.

**Acceptance criteria.**

- `workflow implement(task, role_name) { ... }` parses and `$task`, `$role_name` are available as locals.
- `script check(value) { ... }` works — `$value` available in bash body.
- Default params work: `workflow deploy(env, dry_run = "false")` — `$dry_run` is `"false"` when not provided.
- No-param constructs still work without parentheses: `workflow default { ... }`.
- Arity validation: `run implement` with zero args errors when `implement` declares two required params.
- Both calling conventions work: `run implement "$t" "$r"` (positional) and `run implement task="$t" role_name="$r"` (named).
- Non-bash scripts: params are documentary, no transpiler output for them.
- All existing tests pass after migration.
- Unit test and e2e test covering named params, defaults, and arity validation.

---

## Rewrite docs for script terminology and present-tense language <!-- dev-ready -->

**Goal.** Update all user-facing docs to use `script` terminology (replacing `function`) and remove historical transition framing.

**Scope.**

1. Sweep docs (`README.md`, `docs/*.md`, `docs/index.html`, `docs/jaiph-skill.md`) and replace `function` (Jaiph construct) references with `script`.
2. Add documentation for custom shebang support and polyglot script model.
3. Document named parameters syntax, defaults, and arity validation.
4. Document inline interpolation (`${run ref}`, `${ensure ref}`), dot notation (`${var.field}`), and anonymous scripts.
5. Remove wording that frames rules/scripts as transitions ("no longer", "legacy syntax", "migration patterns").
6. Rewrite those passages to present-tense contracts (what is valid, what is rejected).
7. Keep changelog entries historical. Keep semantics unchanged.

**Acceptance criteria.**

- All docs reference `script` keyword, not `function`.
- Shebang and polyglot model are documented.
- Named parameters documented with examples and default values.
- Inline interpolation, dot notation, and anonymous scripts documented.
- Reference docs read as current behavior contracts, not migration guides.
- Build/tests still pass after wording changes.

---

## Post-refactor sweep: dead code removal and docs cleanup <!-- dev-ready -->

**Goal.** After the script migration phases are complete, remove residual rewrite-era code and perform one final docs consistency sweep.

**Scope.**

1. Remove dead parser/transpiler/runtime helpers that were kept during the refactor but are now unused.
2. Remove temporary compatibility tests/fixtures/messages that no longer protect active behavior.
3. Run a full docs consistency pass across `README.md`, `docs/*.md`, `docs/index.html`, and `docs/jaiph-skill.md` so terminology matches the final grammar/runtime.
4. Eliminate duplicate or contradictory wording between Grammar, CLI, Getting Started, and the skill docs.
5. Keep changes focused on cleanup (no new feature work).

**Acceptance criteria.**

- No unused refactor-era branches/helpers remain in active code paths.
- Docs are internally consistent and aligned with shipped behavior.
- `npm run build && npm test && npm run test:e2e` pass after cleanup.
- Diff is cleanup-only (removals, wording consistency, and minimal wiring fixes).

---

## Reporting server does not mark SIGKILL-terminated runs as ended <!-- dev-ready -->

**Problem.** When `jaiph run` is killed by SIGKILL (or any signal that prevents the normal `WORKFLOW_END` event from being written to `run_summary.jsonl`), the reporting server (`jaiph report`) continues to show the run as active/in-progress indefinitely. There is no `WORKFLOW_END` event to trigger transition to a terminal state.

**Goal.** The reporting server should detect runs that will never complete and mark them as failed/terminated in the UI.

**Approach (investigate and pick one).**

1. **Stale-run detection** — The server already polls `run_summary.jsonl`. If a run has had no new events for a configurable timeout (e.g. `JAIPH_REPORT_STALE_RUN_SEC`, default 120s) and the originating process is no longer alive, mark the run as terminated/stale in the API and UI.
2. **PID-file or lock-file approach** — `jaiph run` writes a PID file (or holds a lock) in the run directory. The reporting server checks whether that PID is still alive; if not, the run is dead.
3. **Hybrid** — Combine timeout heuristic with PID liveness check for reliability.

**Acceptance criteria.**

- A run killed with `kill -9` (SIGKILL) is eventually shown as failed/terminated in `jaiph report`, not stuck as active forever.
- Normal runs that complete with `WORKFLOW_END` are unaffected.
- The detection mechanism has a reasonable latency (under 2–3 poll cycles).
- E2e or integration test: start a run, kill it with SIGKILL, verify `GET /api/active` eventually returns empty and `GET /api/runs` shows the run as failed/terminated.

---

## Add `jaiph format <file>` command <!-- dev-ready -->

**Goal.** Provide an opinionated formatter for `.jh` files that normalizes indentation and spacing.

**Scope.**

1. Add a `format` subcommand to the CLI (`cli/commands/format.ts`). Accepts one or more file paths (`.jh` / `.jph`).
2. Parse each file into the AST, then re-emit the source from the AST with consistent formatting.
3. Support a `--indent` flag (default: `2` spaces). Accepts an integer for the number of spaces per indent level.
4. Write the formatted output back to the file in-place (like `gofmt`). Add `--check` flag that exits non-zero if the file would change (for CI).
5. Formatting rules:
   - Consistent indentation within construct bodies (`workflow`, `rule`, `script`).
   - One blank line between top-level constructs.
   - No trailing whitespace.
   - Consistent spacing around `=` in `const` declarations.
   - Preserve comments in their relative position.
6. If the file fails to parse, emit the parse error and exit non-zero (do not silently corrupt).

**Acceptance criteria.**

- `jaiph format file.jh` reformats the file in-place with 2-space indent.
- `jaiph format --indent 4 file.jh` uses 4-space indent.
- `jaiph format --check file.jh` exits 0 if already formatted, non-zero otherwise.
- Formatting is idempotent: running `jaiph format` twice produces the same output.
- Parse errors produce a clear message and non-zero exit (file is not modified).
- Round-trip: formatted file parses identically to the original (AST equality).
- Unit test and e2e test covering basic formatting and `--check` mode.

---

## Unified mock syntax for all constructs in test files <!-- dev-ready -->

**Goal.** All Jaiph constructs (`prompt`, `rule`, `workflow`, `script`) support both simple string mocks and block body mocks with a consistent syntax.

**Current state.** `mock prompt` supports simple string and block forms. `mock workflow`, `mock rule`, `mock function` only support block body form. `mock function` needs renaming to `mock script`.

**Syntax.**

Prompt (unnamed — applies to all prompts in the test):
```
mock prompt "static response"
mock prompt { <jaiph script code — receives same params as prompt, returns value via stdout> }
```

Named mocks (qualified ref: `name` for local, `alias.name` for imported):
```
mock prompt classify_role "surgical"
mock rule git.is_clean "ok"
mock workflow deploy "done"
mock script select_role "reductionist-role-text"

mock rule git.is_clean { <regular jaiph script code> }
mock workflow deploy { <regular jaiph script code> }
mock script select_role { <regular jaiph script code> }
```

Block bodies receive the same positional args as the real construct and return values via stdout (same contract as scripts).

**Scope.**

1. **Rename** `mock function` → `mock script` in parser (`parse/tests.ts`) and AST (`test_mock_function` → `test_mock_script`). Update `emit-test.ts` accordingly.
2. **Add simple string form** for `mock workflow`, `mock rule`, `mock script`. Currently these only accept `{ body }`. Add parsing for `mock <type> <ref> "response"` that transpiles to a function echoing the string.
3. **Rework `mock prompt { ... }` block** — replace the current `if $1 contains` / `respond` DSL with regular script code (receives prompt text as `$1`, returns value via stdout). Keep the old `if/elif/respond` form working during transition or drop it if you prefer a clean cut.
4. **Add named prompt mock** — `mock prompt <ref> "response"` to mock a specific prompt step by name (when prompts are captured into a `const`).
5. **Update emit-test.ts** — emit mock dispatch for all forms. Simple string mocks emit `echo "response"`. Block mocks emit the body verbatim.
6. **Update existing tests** — rename `mock function` → `mock script` in all `.test.jh` files.

**Acceptance criteria.**

- `mock script <ref> "response"` works (simple string mock for scripts).
- `mock rule <ref> "response"` works (simple string mock for rules).
- `mock workflow <ref> "response"` works (simple string mock for workflows).
- `mock script <ref> { body }` works (block mock, same as before but renamed).
- `mock prompt "response"` still works (unnamed, all prompts).
- `mock prompt { body }` uses regular script code, not `if/respond` DSL.
- Qualified refs work: `mock rule git.is_clean "ok"`.
- `mock function` is no longer accepted (parser error with guidance to use `mock script`).
- All existing test files updated and passing.
- E2e test covering simple string mock for each construct type.

---

## "Try it out" one-liner on landing page + `docs/run` script <!-- dev-ready -->

**Goal.** Add a hero "Try it out" section at the top of the landing page (`docs/index.html`) with a single `curl | bash` one-liner that installs Jaiph (if needed) and runs a sample workflow. Create the `docs/run` script that powers it.

**Landing page (`docs/index.html`).**

Add a section at the top (below header, above existing content) with:

1. Heading: "Try it out!"
2. A styled code block containing:
   ```
   curl -fsSL https://jaiph.org/run | bash -s '
   workflow default {
     const response = prompt "Say: Hello I'\''m [model name]!"
     log "$response"
   }'
   ```
3. A small note below: "Installs Jaiph (if not already installed) and runs the workflow."
4. A copy-to-clipboard button on the code block so the user can paste it into their terminal.
5. Style consistent with the existing page design (dark code block, monospace, subtle button).

**`docs/run` script.**

Create `docs/run` — a bash script served at `https://jaiph.org/run`. When piped through `bash -s '<workflow>'`:

1. **Detect Jaiph**: check if `jaiph` is in `$PATH` (`command -v jaiph`).
2. **Install if missing**: if not found, run `curl -fsSL https://jaiph.org/install | bash` (the existing installer).
3. **Run the workflow**: write the workflow string (passed as `$1` or read from stdin after `-s`) to a temp `.jh` file, run `jaiph run <tempfile>`, clean up.
4. Exit with the workflow's exit code.

**Scope.**

1. Create `docs/run` script (bash, `+x`).
2. Update `docs/index.html` — add "Try it out" section with code block, note, and copy button.
3. Add copy-to-clipboard JS (minimal inline or in `docs/assets/js/main.js`).
4. Ensure the script works end-to-end: fresh machine with `curl` + `node` → installs jaiph → runs the sample workflow → outputs response.
5. The `docs/run` script must be safe: no destructive operations, clear output, fail gracefully if node/npm is missing.

**Acceptance criteria.**

- `curl -fsSL https://jaiph.org/run | bash -s '<workflow>'` installs jaiph (if needed) and executes the workflow.
- If jaiph is already installed, skips installation and runs directly.
- Landing page shows the "Try it out" section with the one-liner.
- Copy button works (copies the full curl command to clipboard).
- The sample workflow actually runs and produces output (requires an AI backend configured, or gracefully shows what would happen).
- `docs/run` exits with the workflow's exit code.
- Script cleans up temp files on exit (trap).

---

## Add Codex backend support for prompts <!-- dev-ready -->

**Goal.** Add a first-class `codex` backend so Jaiph can execute `prompt` steps through Codex with consistent request/response behavior, streaming semantics, and error handling aligned with existing backends.

**Scope.**

1. **Backend config.**
   - Add `codex` as a supported backend option in config parsing/validation.
   - Define required env vars/settings (for example API key, model, optional base URL) with clear validation errors when missing.
2. **Runtime adapter.**
   - Implement a Codex client adapter in runtime prompt execution path.
   - Map Jaiph prompt input to Codex request payload, including system/user text, schema mode, and temperature/options used by existing backends where applicable.
3. **Structured returns compatibility.**
   - Ensure `prompt ... returns '{ ... }'` works with Codex output parsing and existing schema validation.
   - Keep behavior parity for invalid JSON / schema mismatch errors.
4. **Streaming and logging behavior.**
   - Match existing backend behavior for streaming tokens and final captured output.
   - Ensure run artifacts/logging include backend name and useful failure details without leaking secrets.
5. **Tests and docs.**
   - Add/extend unit tests for backend selection, request mapping, and response parsing.
   - Add integration or e2e coverage using mocked Codex responses.
   - Update docs (`README.md`, `docs/cli.md`, `docs/getting-started.md`) with setup and usage examples for `codex`.

**Acceptance criteria.**

- Setting backend to `codex` routes all `prompt` calls through the Codex adapter.
- Missing/invalid Codex configuration fails fast with actionable error messages.
- Plain text prompts and `returns` schema prompts both work with Codex.
- Streaming and non-streaming output behavior matches current backend contract.
- Unit/integration tests for Codex backend pass with the existing suite.
- Docs include Codex setup, required env vars, and a minimal working example.

---
