# Jaiph Improvement Queue

Tasks are processed top-to-bottom. When a task is completed, it is removed from this file.
The first task in the list is always the current task.

---

<!-- TASK id="13" -->
## 13. Strengthen e2e coverage for workflows, rules, and prompts

**Status:** pending

**What:** Add robust end-to-end tests in the `e2e/` directory that use mocked commands and fixtures to validate success and failure scenarios across rules, workflows, and prompt steps.

**Why:** Current confidence is too low for orchestration behavior. We need deterministic e2e coverage that verifies runtime behavior, failure propagation, and user-facing errors.

**Files to change:**
- `e2e/*` — add/extend e2e scenarios and fixtures
- `e2e/ci.sh` — ensure new tests run in CI
- `test fixtures used by e2e` — add mock command scripts and workflow inputs as needed

**Acceptance criteria:**
- E2E suite includes mocked command tests for:
  - passing and failing `rule` execution
  - passing and failing `ensure` inside workflows
  - prompt execution success path
  - prompt failure path and surfaced error
  - nested workflow/run behavior
- Failures from rules/workflows/prompts produce clear, asserted stderr output
- Tests are deterministic (no network/API dependency; fully mocked command behavior)
- `npm run test:e2e` passes locally and in CI

<!-- END_TASK -->

---

<!-- TASK id="12" -->
## 12. Print subtrees for imported workflows in run tree

**Status:** pending

**What:** Expand `jaiph run` tree rendering so `run alias.workflow` entries include nested steps from the imported module (rules, prompts, nested runs), not just a single flat workflow line.

**Why:** The current tree hides execution shape of imported workflows, which makes it look like prompts/rules are skipped and reduces debuggability for orchestrator files like `.jaiph/main.jh`.

**Files to change:**
- `src/cli.ts` — resolve workflow refs across imports and recursively render imported workflow children
- `src/parser.ts` or shared resolver logic — reuse/introduce import resolution helper for CLI tree building
- `e2e/*` or CLI tests — assert dotted workflow refs show nested tree rows

**Acceptance criteria:**
- `jaiph run .jaiph/main.jh` prints nested tree rows for `implement.default`, `docs.default`, and `git.commit`
- Prompt steps inside imported workflows appear in the tree
- Existing local (non-imported) subtree rendering remains unchanged
- Recursive rendering avoids infinite loops on cyclic references
- Nested tree is observable when running `jaiph test .jaiph/main.jh` with mocks

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

**Tests / acceptance:**
- Testable with `jaiph test`: workflow using `ensure --retry N` can be run with mocks (e.g. rule fails then succeeds within retries).

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
- `jaiph test` continues to use mocks only; test mode must not invoke Claude CLI

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
- Testable with `jaiph test`: mock JSON response that satisfies the schema is accepted and typed fields are available

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
- Testable with `jaiph test`: mock response is unpacked into prefixed variables

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
