# Jaiph Improvement Queue

Tasks are processed top-to-bottom. When a task is completed, it is removed from this file.
The first task in the list is always the current task.

---

<!-- TASK id="0" -->
## 0. Upgrade project version to `0.2.0`

**Status:** pending

**What:** Update project version to 0.2.0, current one is 0.1.0. Search for all occurences in docs and in the code

<!-- END_TASK -->

---

<!-- TASK id="11" -->
## 11. Print output of errored rule/workflow in failure summary

**Status:** done

**What:** When a workflow run fails, the CLI prints the stderr of the failed step (rule or workflow) in the failure summary so the user sees why it failed without opening log files.

**Why:** Reduces friction when debugging: "ensure: command not found" or other step errors are visible immediately.

**Implemented:** On failure, read the run summary JSONL, find the first STEP_END with status !== 0, read that step's err_file, and print its content (up to 30 lines) under "Output of failed step:". Also fixed `ensure` inside rule bodies so they compile to the actual rule invocation (was emitting raw "ensure" as shell).

<!-- END_TASK -->

---

<!-- TASK id="10" -->
## 10. Introduce `.jh` extension with backward-compatible `.jph` support

**Status:** pending

**What:** Support `.jh` as the primary Jaiph file extension while keeping `.jph` fully functional during a migration window.

**Why:** `.jh` is shorter, easier to type, and aligns better with shell-adjacent naming (`.sh`) without changing language semantics.

**Migration policy:**
- `.jh` becomes the recommended extension in docs/examples
- `.jph` remains supported for at least one release cycle
- CLI emits a clear deprecation notice for new `.jph` usage where appropriate
- Provide a mechanical migration path (`mv *.jph *.jh`) and compatibility guidance

**Files to change:**
- `src/cli.ts` — accept both `.jh` and `.jph` entrypoints/import targets
- `src/parser.ts` and/or import resolver path logic — extension resolution compatibility
- `docs/getting-started.md` — switch examples to `.jh`
- `docs/cli.md` and `docs/grammar.md` — document dual support and migration guidance
- `e2e/*` and fixture workflows — add or migrate coverage for `.jh`
- `docs/index.html` - ensure samples show `.jh` extension, no need to mention jph

**Acceptance criteria:**
- `jaiph run file.jh` works
- Existing `.jph` projects continue to run unchanged
- Imports resolve correctly for both extensions
- Test suite covers mixed-extension projects
- Deprecation messaging is explicit, non-breaking, and documented

<!-- END_TASK -->

---

<!-- TASK id="1" -->
## 1. Forbid `run` inside `rule` blocks

**Status:** pending

**What:** Remove the current context-sensitive behaviour where `run` inside a `rule` silently falls back to a raw shell command. Rules should only be able to call other rules via `ensure`. Using `run` inside a `rule` must be a hard compile-time error.

**Why:** The dual meaning of `run` (workflow call in workflows, shell shorthand in rules) is a footgun. It creates silent, hard-to-debug behaviour differences depending on where the keyword appears.

**Files to change:**
- `src/parser.ts` — during rule body parsing, track the current block context (`rule` vs `workflow`)
- `src/transpiler.ts` — emit a compile error if a `run` statement is found inside a rule context

**Expected compiler error message:**
```
Error: `run` is not allowed inside a `rule` block.
Use `ensure` to call another rule, or move this call to a `workflow`.
```

**Tests to add:**
- Verify a `.jph` file with `run` inside a `rule` fails to compile
- Verify `ensure other_rule` inside a `rule` still compiles correctly

<!-- END_TASK -->

---

<!-- TASK id="3" -->
## 3. Output capture from `prompt`

**Status:** pending

**What:** Allow capturing the stdout of a `prompt` call into a named variable:

```
result = prompt "Summarize the changes made"
```

The variable `$result` is then available as a standard bash variable in the rest of the workflow.

**Why:** Currently `prompt` is fire-and-forget. Without output capture, workflows cannot make decisions based on what an agent returned, severely limiting orchestration logic.

**Files to change:**
- `src/parser.ts` — parse the `name = prompt "..."` assignment form
- `src/transpiler.ts` — emit `name=$(jaiph__prompt "...")` in the compiled bash
- `src/stdlib.sh` — verify `jaiph__prompt` writes to stdout

**Example compiled output:**
```bash
result=$(jaiph__prompt "Summarize the changes made")
```

**Tests to add:**
- Capture compiles to correct bash assignment
- Variable is accessible in subsequent bash expressions within the same workflow

<!-- END_TASK -->

---

<!-- TASK id="7" -->
## 7. `jaiph test` command with prompt mocking

**Status:** pending

**What:** Add a `jaiph test` subcommand that runs workflows in test mode, intercepting `prompt` calls and substituting mock responses.

**Why:** Prompt-heavy workflows need deterministic tests before adding more syntax/semantics. This reduces regression risk for the full automation flow.

**Test file format** (`.jaiph/tests/<name>.test.toml`):
```toml
[[mock]]
prompt_contains = "Analyse the diff"
response = '{"type":"refactor","risk":"low","summary":"Renamed variables"}'

[[mock]]
prompt_contains = "Update docs"
response = "Documentation updated."
```

**CLI usage:**
```
jaiph test e2e/say_hello.jph
jaiph test .jaiph/main.jph "implement feature X"
```

**Behaviour:**
- Intercepts each `jaiph__prompt` / `jaiph__prompt_typed` call
- Matches mock by `prompt_contains` substring
- Substitutes mock `response` as stdout
- Fails if a prompt call has no matching mock
- Reports pass/fail per step

**Files to change:**
- `src/cli.ts` — add `test` subcommand
- `src/stdlib.sh` — check `JAIPH_TEST_MODE=1` and `JAIPH_MOCK_FILE`; route prompts through mock resolver
- New file: `src/mock-resolver.ts` — matches prompt text against mock definitions
- `e2e/say_hello.jph` — ensure it is runnable under `jaiph test` with a mock file
- `.jaiph/main.jph` — ensure full flow can be tested in deterministic mode without side effects

**Acceptance criteria:**
- `jaiph test e2e/say_hello.jph` passes with mocks
- `jaiph test .jaiph/main.jph "<input>"` executes the full flow with mocked prompts
- Test mode does not perform real networked prompt calls
- Test mode can avoid destructive side effects (commit/push) while validating flow wiring

<!-- END_TASK -->

---



<!-- TASK id="12" -->
## 12. Print subtrees for imported workflows in run tree

**Status:** pending

**What:** Expand `jaiph run` tree rendering so `run alias.workflow` entries include nested steps from the imported module (rules, prompts, nested runs), not just a single flat workflow line.

**Why:** The current tree hides execution shape of imported workflows, which makes it look like prompts/rules are skipped and reduces debuggability for orchestrator files like `.jaiph/main.jph`.

**Files to change:**
- `src/cli.ts` — resolve workflow refs across imports and recursively render imported workflow children
- `src/parser.ts` or shared resolver logic — reuse/introduce import resolution helper for CLI tree building
- `e2e/*` or CLI tests — assert dotted workflow refs show nested tree rows

**Acceptance criteria:**
- `jaiph run .jaiph/main.jph` prints nested tree rows for `implement.default`, `docs.default`, and `git.commit`
- Prompt steps inside imported workflows appear in the tree
- Existing local (non-imported) subtree rendering remains unchanged
- Recursive rendering avoids infinite loops on cyclic references

<!-- END_TASK -->

---

<!-- TASK id="4" -->
## 4. `ensure` with retry support

**Status:** pending

**What:** Add an optional `--retry N` flag to `ensure` that retries a failing rule up to N times before propagating failure:

```
ensure --retry 3 build_passes
ensure --retry 3 --delay 5 flaky_network_check
```

Optional `--delay S` adds a sleep of S seconds between retries.

**Why:** In real CI/agent environments, rules often fail transiently. Without retry, users wrap `ensure` in custom bash loops, defeating the point of the abstraction.

**Files to change:**
- `src/parser.ts` — parse `--retry N` and `--delay S` flags on `ensure` statements
- `src/transpiler.ts` — emit a retry loop in the compiled bash
- `src/stdlib.sh` — add `jaiph__ensure_retry` helper

**Example compiled output:**
```bash
jaiph__ensure_retry 3 5 main__rule_build_passes
```

<!-- END_TASK -->

---

<!-- TASK id="9" -->
## 9. Support Claude CLI as prompt backend

**Status:** pending

**What:** Add support for using Claude CLI as an alternative backend for `prompt` execution in Jaiph workflows.

**Why:** Users should be able to run the same workflows with different agent CLIs without rewriting workflow logic.

**Files to change:**
- `src/stdlib.sh` — route `jaiph__prompt` through a configurable backend
- `src/cli.ts` — expose backend selection (flag/env/config)
- `docs/cli.md` — document backend selection and Claude CLI requirements
- `docs/configuration.md` — document config key(s) for backend choice

**Acceptance criteria:**
- User can select backend as Claude CLI globally or per invocation
- Existing default backend remains unchanged and backward compatible
- Output capture (`result = prompt "..."`) continues to work with Claude CLI backend
- Clear error if Claude CLI is selected but unavailable

<!-- END_TASK -->

---

<!-- TASK id="6" -->
## 6. Project-local stdlib version pinning

**Status:** pending

**What:** Allow a project to pin the Jaiph stdlib version in `.jaiph/config.toml`. When set, `jaiph run` uses that pinned stdlib from a local cache.

**Config example:**
```toml
stdlib_version = "0.2.3"
```

**Files to change:**
- `src/cli.ts` — resolve stdlib path from config before running; download and cache to `~/.cache/jaiph/stdlib/<version>/jaiph_stdlib.sh` if not present; set `JAIPH_STDLIB` accordingly
- `docs/configuration.md` — document the new key

<!-- END_TASK -->

---

<!-- TASK id="2" -->
## 2. Fix `||` / `{ ... }` inline brace-group parser limitation

**Status:** pending

**What:** The parser currently fails on short-circuit brace-group patterns like `cmd || { echo "failed"; exit 1; }`. Users must work around this with explicit `if/then/fi` blocks.

**Why:** This is a common bash idiom. Blocking it is a sharp edge for shell-fluent users and produces confusing parse errors.

**Files to change:**
- `src/parser.ts` — extend the grammar to handle inline brace groups as a statement form

**Acceptance criteria:**
- The following compiles correctly:
  ```
  rule example {
    check_something || { echo "check failed"; exit 1; }
  }
  ```
- Existing `if ! cmd; then ...; fi` patterns continue to work

<!-- END_TASK -->

---

<!-- TASK id="5a" -->
## 5a. Typed `prompt` schema validation (without dot syntax)

**Status:** pending

**What:** Add `returns { ... }` syntax on prompt assignment and validate returned JSON against declared fields/types.

**V1 scope constraints:**
- Schema is flat only (no nested objects)
- No arrays or union types in v1
- Supported field types are only `string`, `number`, `boolean`

**Syntax:**
```
result = prompt "Analyse the diff and classify the change" returns {
  type: string,
  risk: string,
  summary: string
}
```

**Files to change:**
- `src/parser.ts` — parse `returns { field: type, ... }` annotation
- `src/transpiler.ts` — emit typed prompt call with schema payload
- `src/stdlib.sh` — add helper that injects schema instructions and validates response JSON

**Acceptance criteria:**
- Valid JSON response passes and exposes typed fields for extraction
- Missing field fails with clear field-specific schema error
- Invalid JSON fails with parse error
- Unsupported declared type fails with compile-time schema error
- Raw `$result` still contains the original JSON string
- Error classes are distinct and test-covered: parse error vs schema/type error vs missing-field error

<!-- END_TASK -->

---

<!-- TASK id="5b" -->
## 5b. Deterministic field export for typed prompts

**Status:** pending

**What:** Eagerly unpack typed response fields into prefixed variables immediately after prompt execution.

**Example:** `result` with field `risk` creates `$result_risk`.

**Why:** Keeps runtime simple and avoids repeated JSON parsing throughout workflows.

**Files to change:**
- `src/transpiler.ts` — emit unpack/export logic
- `src/stdlib.sh` — support extraction/export implementation

**Acceptance criteria:**
- `$result` contains raw JSON
- `$result_<field>` variables are available in subsequent steps
- No additional `jq` call is needed at each access site
- Export behaviour is deterministic for all declared primitive fields (`string|number|boolean`)

<!-- END_TASK -->

---

<!-- TASK id="5c" -->
## 5c. Dot notation sugar for typed prompt fields

**Status:** pending

**What:** Support `result.field` syntax in workflow expressions as sugar for `$result_field`.

**Why:** Improves readability without adding runtime overhead.

**Files to change:**
- `src/parser.ts` — parse `name.field` in relevant expression contexts
- `src/transpiler.ts` — compile to prefixed bash variable references

**Acceptance criteria:**
- `result.type` compiles to `$result_type`
- Generated bash has no dynamic field lookup calls at access sites
- Existing non-dot syntax remains backward compatible
- Dot notation is sugar only and cannot bypass schema validation rules from 5a

<!-- END_TASK -->

---

<!-- TASK id="8" -->
## 8. Package registry via GitHub

**Status:** pending

**What:** Allow importing Jaiph modules from GitHub using a `github:` URI scheme:

```
import "github:org/repo/path/to/file.jph@v1.2.0" as security
```

Jaiph resolves, downloads, and caches the module on first use.

**Resolution rules:**
- `@tag` pins to a git tag
- `@sha` pins to a commit SHA
- Without `@` resolves to `main` with a warning (unpinned)
- Cache location: `~/.cache/jaiph/modules/<org>/<repo>/<ref>/`

**Files to change:**
- `src/parser.ts` — recognise `github:` prefix in import paths
- `src/transpiler.ts` — resolve remote imports before compilation, substituting cache paths
- `src/cli.ts` — add `module update` subcommand to refresh unpinned imports
- `docs/getting-started.md` — document remote imports

<!-- END_TASK -->
