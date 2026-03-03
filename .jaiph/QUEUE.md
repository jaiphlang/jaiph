# Jaiph Improvement Queue

Tasks are processed top-to-bottom. When a task is completed, it is removed from this file.
The first task in the list is always the current task.

<!-- TASK id="11" -->
## 11. Refactor `src/cli.ts` into composable command/runtime modules

**Status:** pending

**What:** Split the current monolithic CLI into focused modules while preserving exact user-facing behavior.

**Why:** `src/cli.ts` currently mixes command parsing, workflow process lifecycle, event parsing, progress rendering, init/use logic, and error reporting. This is the highest coupling hotspot and biggest blocker for safe iteration.

**Target module boundaries:**
- `src/cli/index.ts` — command routing + top-level error handling
- `src/cli/commands/{build,run,test,init,use}.ts` — command-specific orchestration
- `src/cli/run/lifecycle.ts` — subprocess launch, signals, exit handling
- `src/cli/run/events.ts` — runtime event parsing and validation
- `src/cli/run/progress.ts` — tree/progress rendering only
- `src/cli/shared/{usage,paths,errors}.ts` — reusable helpers

**Constraints:**
- No intentional behavior changes in CLI output, exit codes, or flags.
- Preserve current acceptance behavior and all existing tests.

**Acceptance criteria:**
- `npm test` and `npm run test:acceptance` remain green.
- `jaiph run/test/init/use` UX and error messages remain backward-compatible.
- Signal handling behavior remains unchanged (documented by tests).

<!-- END_TASK -->

---

<!-- TASK id="12" -->
## 12. Refactor `src/transpiler.ts` into phase-based pipeline

**Status:** pending

**What:** Decompose transpiler into explicit phases with pure core logic and minimal IO wrappers.

**Why:** Current file couples path resolution, semantic validation, emission, and filesystem traversal/writes. This makes changes risky and obscures compiler invariants.

**Target module boundaries:**
- `src/transpile/resolve.ts` — import/workflow symbol/path resolution
- `src/transpile/validate.ts` — semantic reference validation (rules/workflows/tests)
- `src/transpile/emit-workflow.ts` — workflow shell emission
- `src/transpile/emit-test.ts` — test shell emission
- `src/transpile/build.ts` — directory walking + output writes

**Constraints:**
- Preserve emitted shell contract and deterministic errors (`E_PARSE`, `E_VALIDATE`, `E_IMPORT_NOT_FOUND`).
- Preserve extension-resolution behavior and current import semantics.

**Acceptance criteria:**
- Existing compiler golden and acceptance tests pass unchanged.
- Emitted output for current goldens remains stable.
- Public API (`build`, `transpileFile`, `transpileTestFile`) remains compatible.

<!-- END_TASK -->

---

<!-- TASK id="13" -->
## 13. Refactor parser into grammar-domain modules

**Status:** pending

**What:** Split parser logic by domain (`imports/rules/functions/workflows/tests`) with shared parse primitives.

**Why:** Parser currently handles many unrelated branches in one pass, which increases risk of regressions when adding syntax features.

**Target module boundaries:**
- `src/parse/core.ts` — line scanning, shared helpers, error helpers
- `src/parse/imports.ts`
- `src/parse/rules.ts`
- `src/parse/functions.ts`
- `src/parse/workflows.ts`
- `src/parse/tests.ts`

**Constraints:**
- Preserve all existing syntax and error message shape/location.
- Do not introduce new grammar features in this task.

**Acceptance criteria:**
- Parser acceptance tests for malformed syntax remain green and deterministic.
- Existing runtime/compiler tests pass without fixture rewrites.

<!-- END_TASK -->

---

<!-- TASK id="14" -->
## 14. Refactor runtime stdlib shell into sourced submodules

**Status:** pending

**What:** Break `src/jaiph_stdlib.sh` into focused sourced parts while preserving runtime API and behavior.

**Why:** Prompt execution, step eventing, run artifact writing, and readonly sandbox logic are currently co-located, making runtime hard to reason about and extend safely.

**Target module boundaries:**
- `src/runtime/prompt.sh`
- `src/runtime/events.sh`
- `src/runtime/steps.sh`
- `src/runtime/sandbox.sh`
- `src/runtime/test-mode.sh`
- thin aggregator `src/jaiph_stdlib.sh`

**Constraints:**
- Keep runtime API version and exported function contract stable.
- Preserve current behavior on both sandbox-capable and fallback hosts.

**Acceptance criteria:**
- `npm run test:acceptance:runtime` passes unchanged.
- Run artifact contract (`run_summary.jsonl`, `.out/.err`) remains stable.
- No CLI behavior differences caused by stdlib modularization.

<!-- END_TASK -->

---

<!-- TASK id="15" -->
## 15. Add signal/lifecycle acceptance coverage before deep CLI surgery

**Status:** pending

**What:** Add a deterministic acceptance test that validates `jaiph run` interruption behavior (SIGINT/SIGTERM path, non-hanging exit, cleanup).

**Why:** Process lifecycle is the highest-risk area during CLI refactor and currently under-tested compared with parser/transpiler/runtime semantics.

**Scope:**
- Spawn a long-running workflow in a controlled test process.
- Interrupt it and assert non-zero exit + bounded completion time.
- Assert no stale child workflow process remains under the test process group.

**Acceptance criteria:**
- Test is reliable in CI and local development.
- Captures current lifecycle behavior as a lock before refactor.

<!-- END_TASK -->

---

<!-- TASK id="10" -->
## 10. Move config to in-file workflow metadata

**Status:** pending

**What:** Replace external config-file dependency (`.jaiph/config.toml`, global config) with project-local in-file metadata declared inside `.jh/.jph` entry files.

**Why:** Current config layering adds complexity and hidden behavior. In-file config keeps execution context explicit, portable, and reviewable together with workflow logic.

**V1 direction:**
- Introduce a top-level metadata block in workflow files (syntax TBD) for runtime options currently read from config/env.
- Support key runtime settings first (e.g. model selection, runs/log directory).
- Keep temporary backward compatibility with existing config files, but define explicit precedence and migration warning.

**Files to change:**
- `src/parser.ts` — parse and validate top-level metadata block
- `src/transpiler.ts` — propagate metadata into generated runtime/env wiring
- `src/cli.ts` — consume in-file metadata as primary source and limit config fallback
- `docs/configuration.md` + `docs/grammar.md` — document new in-file config model and migration

**Acceptance criteria:**
- User can run a workflow with no external config files and get deterministic behavior from in-file metadata.
- Metadata parse errors are explicit (`E_PARSE`) and point to file location.
- Existing projects using config files still run during migration window with clear deprecation warning.
- E2E coverage verifies metadata-driven behavior end-to-end.

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
## 5a. Typed `prompt` schema validation with `--returns`

**Status:** pending

**What:** Add `--returns { ... }` syntax on prompt assignment and validate returned JSON against declared fields/types.

**V1 scope constraints:**
- Schema is flat only (no nested objects)
- No arrays or union types in v1
- Supported field types are only `string`, `number`, `boolean`

**Syntax:**
```
result = prompt "Analyse the diff and classify the change" --returns {
  type: string,
  risk: string,
  summary: string
}
```

Allow multiline prompt + typed schema in bash style with line continuation:
```
result = prompt "Analyse the diff and classify the change" \
  --returns {
    type: string,
    risk: string,
    summary: string
  }
```

**Files to change:**
- `src/parser.ts` — parse `--returns { field: type, ... }` annotation (including `\` line continuation)
- `src/transpiler.ts` — emit typed prompt call with schema payload
- `src/stdlib.sh` — add helper that injects schema instructions and validates response JSON

**Acceptance criteria:**
- Valid JSON response passes and exposes typed fields for extraction
- Missing field fails with clear field-specific schema error
- Invalid JSON fails with parse error
- Unsupported declared type fails with compile-time schema error
- Legacy `prompt ... returns { ... }` syntax is a hard error with a migration hint to `--returns`
- Raw `$result` still contains the original JSON string
- Error classes are distinct and test-covered: parse error vs schema/type error vs missing-field error
- Testable with `jaiph test`: mock JSON response that satisfies the schema is accepted and typed fields are available
- Parser tests cover both single-line and multiline (`\`) `--returns` forms

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
