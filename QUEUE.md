# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Dark mode for docs site (landing + Jekyll pages) with top-right toggle <!-- dev-ready -->

**Goal.** Add light/dark theme support for the public docs site: `docs/index.html` (landing) and all other Jekyll-rendered pages under `docs/`, with a visible theme switch fixed or placed at the **top right** of the page. Respect `prefers-color-scheme` as the default when the user has not chosen a preference; persist the user’s choice (e.g. `localStorage`) across navigations. **Syntax highlighting** must follow the page theme: keep the current **GitHub Light**–style token colors in light mode and add a **GitHub Dark**–style palette in dark mode (same highlighter markup, theme-dependent CSS — not light-only highlights on a dark background).

**Scope.**

1. **`docs/assets/css/style.css`** — Define CSS custom properties (or equivalent) for light and dark palettes; use `[data-theme="dark"]` on `<html>` or `<body>` (or `.theme-dark` root class) so one stylesheet serves both themes. Ensure contrast, links, code blocks, cards, and buttons remain readable in dark mode. For fenced / `pre code` blocks and any custom highlighter spans (e.g. classes emitted by `docs/assets/js/main.js`), map token colors to **GitHub Light** vs **GitHub Dark** conventions (keywords, strings, comments, functions, etc.) so dark mode is not “light scheme on dark gray”.
2. **`docs/index.html`** — Add a compact theme control in the header area **top right** (toggle button, switch, or sun/moon control) wired to flip theme and persist preference.
3. **Jekyll layouts** — Identify shared layout(s) (e.g. `_layouts/default.html` or equivalent) and include the same theme control + minimal inline script or shared `docs/assets/js` snippet so every doc page gets the switch in the same position.
4. **JavaScript** — On load: read saved preference; if none, follow `prefers-color-scheme`. On toggle: update root attribute/class, save preference, update any `meta theme-color` if present for mobile chrome.
5. **No flash of wrong theme (optional but preferred)** — Inline a tiny script in `<head>` or critical CSS that applies the saved/system theme before first paint, or document tradeoff if deferred.

**Acceptance criteria.**

- Landing page (`docs/index.html`) shows a theme control at the **top right**; toggling switches between coherent light and dark styles.
- At least one non-landing Jekyll page (e.g. getting-started or default layout) shows the same control in the same position and behavior.
- First visit with no saved preference matches system light/dark (`prefers-color-scheme`).
- Reloading or navigating to another page keeps the user’s explicit choice until cleared.
- Focus states and keyboard use remain usable for the theme control (accessibility).
- In **dark** mode, syntax-highlighted code (landing samples, doc pages, tabbed examples) uses **GitHub Dark**–aligned token colors; in **light** mode, highlighting stays **GitHub Light**–aligned (current behavior preserved).

---

## Hard-cut migration: replace Bash orchestration runtime with JS runtime kernel <!-- dev-ready -->

**Goal**  
Remove Bash as the orchestration runtime target and execute workflows through a JavaScript runtime kernel while preserving **all** user-facing behavior and run artifacts contracts.

**Context**  
Bash remains valid for *user-authored script bodies* (including shebang-based polyglot scripts). All orchestration semantics (workflow, rule, prompt, ensure, run, channels, hooks wiring, event emission, test mode) move to a new JS/TS runtime kernel.

**Execution model change**  
Move from “transpile to Bash + external execution” to “in-process JS kernel interpretation inside the Bun standalone CLI binary” while keeping user script bodies as spawned external processes.

**Non-negotiable contracts (must remain stable)**

1. CLI output/e2e behavior contracts for `jaiph run` and `jaiph test`.
2. `__JAIPH_EVENT__` event stream shape and ordering guarantees used by CLI progress.
3. `.jaiph/runs` artifact layout, including step `.out`/`.err` logs and prompt artifacts.
4. `run_summary.jsonl` schema and event semantics (`STEP_*`, `LOG*`, `INBOX_*`, workflow boundaries).
5. Channels and hooks behavior from the user perspective.

**Scope**

1. Replace `src/jaiph_stdlib.sh` + `src/runtime/*.sh` orchestration behavior with new JS/TS runtime modules (`src/runtime/kernel/`).
2. Keep parser/validator language surface intact unless migration requires targeted changes.
3. Keep user-authored script bodies (including shebang polyglot scripts) executed as external processes via `Bun.spawn` / `child_process`, preserving full isolation and shebang behavior.
4. Keep channel transport and all reporting artifacts file-based under `.jaiph/runs` (no in-memory-only queue rewrite).
5. Keep `jaiph test` semantics intact for `*.test.jh`, including mocks and assertions.
6. Update the transpiler (`transpileFile` / `transpileTestFile`) and CLI execution launcher (`src/cli/run/*`) so workflows are executed by the new JS runtime kernel instead of generated Bash. **Prefer in-process AST interpretation** inside the CLI binary for better debugging and source mapping.
7. Update the build pipeline so the CLI becomes a **single-file Bun standalone executable** (`bun build --compile --outfile jaiph ...`) supporting Linux/macOS/Windows (x64 + arm64). The JS runtime kernel runs inside this binary.
8. Port the following orchestration primitives 1:1 into the new kernel:
   - Step execution (`run`, `ensure`, `rule`, etc.)
   - Prompt flow handling + artifact capture
   - Channel / inbox init, send, route registration, queue drain (file-based)
   - Event emission (`__JAIPH_EVENT__` JSON lines on stderr)
   - Test-mode behavior (`JAIPH_TEST_MODE`, mocks, assertions)
   - Hook wiring (still triggered from CLI, payload passing unchanged)
9. Add source-map / line-number support so runtime errors in the JS kernel point back to the original `.jh` file + line.
10. Preserve all existing environment variables (`JAIPH_TEST_MODE`, etc.) and working-directory behavior.
11. Update docs and architecture docs (`ARCHITECTURE.md` including all Mermaid diagrams) and any user-facing READMEs to reflect the new JS runtime kernel, in-process execution model, and removed Bash orchestration target.

**Acceptance criteria**

- `npm run build`, `npm test`, and `npm run test:e2e` pass after migration.
- Existing e2e contracts for CLI output remain green **without broad rebaselining**.
- Event stream consumed by CLI progress remains fully compatible (`__JAIPH_EVENT__` parser unchanged or equivalent).
- `.jaiph/runs` and `run_summary.jsonl` remain byte-for-byte compatible with the reporting server and existing tooling.
- Channels, hooks, and prompt flows behave **equivalently** from the user perspective.
- The shipped `jaiph` binary is a **single standalone executable** with zero external runtime dependencies.
- Runtime errors and stack traces are at least as debuggable as the old Bash version (ideally better).

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

## Distribution migration: ship `jaiph` as Bun standalone executable <!-- dev-ready -->

**Goal.** Replace Node-based distribution with a standalone Bun-compiled executable so users can run Jaiph without Node runtime installation.

**Scope.**

1. Add Bun build target for CLI/runtime binary (`bun build --compile`).
2. Produce release artifacts for supported OS/arch matrix.
3. Update install/release scripts and docs to download the standalone binary.
4. Validate runtime behavior parity between development run mode and compiled binary mode.
5. Keep `jaiph run`, `jaiph test`, `jaiph build`, `jaiph report`, `jaiph init`, and `jaiph use` behavior stable.

**Acceptance criteria.**

- Standalone binary runs on supported targets without Node installed.
- Core commands pass smoke/integration checks in compiled mode.
- Installer and docs are updated to binary-first flow.
- No regression in `.jaiph/runs` artifacts, event stream, or reporting server behavior.

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
