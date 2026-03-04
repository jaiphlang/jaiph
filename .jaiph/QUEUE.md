# Jaiph Improvement Queue

Tasks are processed top-to-bottom. When a task is completed, it is removed from this file.
The first task in the list is always the current task.

---

<!-- TASK id="11" -->
## 11. Remove TOML runtime config and inline test mocks

**Status:** pending

**What:** Remove all TOML-like project configuration paths by:
- removing runtime TOML config (`.jaiph/config.toml`, global `~/.config/jaiph/config.toml`), and
- moving prompt test mocks into inline `mock prompt { ... }` blocks inside `*.test.jh` files.

**Why:** Runtime behavior should be explicit and local to workflow files. Keeping TOML fallback creates hidden precedence and migration complexity.

**Scope:**
- `jaiph run` must no longer read TOML config files.
- `jaiph init` must stop generating `.jaiph/config.toml`.
- Docs/examples must stop recommending TOML runtime config.
- Backward-compat fallback and deprecation notices can be removed.
- `jaiph test` must no longer depend on `.jaiph/tests/*.test.toml` files.
- Prompt mocks must be declared inline in test files.

**Inline mock syntax (v1):**
- Inside `test "..." { ... }`, support:
  - `mock prompt {`
  - `if $1 contains "..." ; then`
  - `elif $1 contains "..." ; then`
  - optional `else`
  - `respond "..."`
  - `fi`
  - `}`

**Files to change:**
- `src/config.ts` — remove TOML parser/loading APIs and keep metadata mapping utilities only.
- `src/cli/commands/run.ts` — stop `loadJaiphConfig` + fallback merge; use metadata + env only.
- `src/cli/commands/init.ts` — remove config template creation/output text.
- `docs/configuration.md`, `docs/cli.md`, `README.md` — remove runtime TOML references and update precedence docs.
- tests touching config fallback behavior (`e2e/tests/85_infile_metadata.sh`, unit tests if any).
- `src/parse/tests.ts` (and shared parse helpers) — parse inline `mock prompt` blocks.
- `src/transpile/emit-test.ts` — emit inline mock dispatch logic.
- `src/runtime/test-mode.sh` + `src/runtime/prompt.sh` — consume inline mocks instead of fixture files.
- `src/cli/commands/test.ts` — remove `.test.toml` resolution and update error/help text.
- `src/mock-resolver.ts` — delete or repurpose (no TOML mock parser in test path).
- docs/tests that currently use `.test.toml` — migrate examples and e2e/unit coverage to inline mocks.

**Acceptance criteria:**
- Runtime config precedence is: env vars > in-file metadata > built-in defaults.
- `.jaiph/config.toml` and global config files are ignored by runtime.
- `jaiph init` does not create `.jaiph/config.toml`.
- Docs contain no runtime-config TOML instructions.
- `jaiph test` runs with no external `.test.toml` fixture requirement.
- Inline `mock prompt` supports `if/elif/else/fi` with `contains` matching and deterministic first-match behavior.
- Missing mock match (without `else`) fails with clear test-time error.
- Parser/runtime errors for malformed inline mock blocks are explicit and test-covered.

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
- `src/parse/workflows.ts` and/or shared step parser — parse `--retry N` and `--delay S` on `ensure`.
- `src/transpile/emit-workflow.ts` — emit retry-enabled ensure call in generated bash.
- `src/jaiph_stdlib.sh` — add `jaiph__ensure_retry` helper and integrate with step eventing.
- parser/transpiler tests + e2e flaky-case coverage.

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
- `src/jaiph_stdlib.sh` + `src/runtime/prompt.sh` — route prompt execution through a backend abstraction.
- `src/cli/commands/run.ts` + `src/parse/metadata.ts` — expose backend selection via env + in-file metadata (not TOML).
- `docs/cli.md` + `docs/configuration.md` — document backend selection and Claude CLI requirements.
- tests for backend dispatch, missing binary errors, and test-mode isolation.

**Acceptance criteria:**
- User can select backend per invocation (env) and per entry workflow (metadata).
- Existing default backend remains unchanged and backward compatible
- Output capture (`result = prompt "..."`) continues to work with Claude CLI backend
- Clear error if Claude CLI is selected but unavailable
- `jaiph test` continues to use mocks only; test mode must not invoke Claude CLI

<!-- END_TASK -->

---

<!-- TASK id="6" -->
## 6. Project-local stdlib version pinning

**Status:** pending

**What:** Allow a project to pin Jaiph stdlib version via in-file metadata (for example `run.stdlib_version = "0.2.3"`). `jaiph run` should resolve/download cached stdlib for that version.

**Files to change:**
- `src/parse/metadata.ts` + `src/types.ts` — add and validate `run.stdlib_version`.
- `src/cli/commands/run.ts` — resolve stdlib path from metadata; download/cache to `~/.cache/jaiph/stdlib/<version>/jaiph_stdlib.sh`; set `JAIPH_STDLIB`.
- `docs/configuration.md` — document metadata key and precedence with env override.
- tests for cache hit/miss and invalid version error handling.

<!-- END_TASK -->

---

<!-- TASK id="2" -->
## 2. Fix `||` / `{ ... }` inline brace-group parser limitation

**Status:** pending

**What:** The parser currently fails on short-circuit brace-group patterns like `cmd || { echo "failed"; exit 1; }`. Users must work around this with explicit `if/then/fi` blocks.

**Why:** This is a common bash idiom. Blocking it is a sharp edge for shell-fluent users and produces confusing parse errors.

**Files to change:**
- `src/parse/workflows.ts` (and shared statement parsing, if needed) — extend grammar handling for inline brace groups.
- regression tests covering `|| { ... }` in rule/workflow bodies.

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
- `src/parse/workflows.ts` (prompt parsing path) — parse `--returns { field: type, ... }` including `\` continuation.
- `src/transpile/emit-workflow.ts` — emit typed prompt call + schema payload.
- `src/jaiph_stdlib.sh` — schema-aware prompt helper + JSON validation.
- parser, transpile, and e2e tests for parse/type/missing-field error classes.

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
- `src/transpile/emit-workflow.ts` — emit deterministic unpack/export logic.
- `src/jaiph_stdlib.sh` — extraction/export helper implementation.
- tests for shell-safe export and primitive typing.

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
- `src/parse/workflows.ts` + expression helpers — parse `name.field` in supported contexts.
- `src/transpile/emit-workflow.ts` — compile to prefixed bash variable references.
- parser/transpiler tests for compatibility with existing syntax.

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
- `src/parse/imports.ts` — recognise `github:` import URI format.
- `src/transpile/resolve.ts` + build pipeline (`src/transpiler.ts`) — resolve/download/cache remote imports before transpilation.
- `src/cli/index.ts` + new `src/cli/commands/module.ts` — add `jaiph module update` for refreshing unpinned imports.
- `docs/getting-started.md` — document remote imports

<!-- END_TASK -->
