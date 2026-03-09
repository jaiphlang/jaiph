# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## 11. Show step parameters inline in tree output

**Status:** pending

**What:** When runtime tree output includes parameterized invocations, render passed parameters in gray immediately after step labels for `workflow`, `prompt`, and `function` nodes.

**Why:** Current tree output hides invocation context, so it is hard to distinguish repeated steps (for example multiple `workflow docs_page` runs) and debug argument flow.

**Expected rendering (example intent):**
- `▸ workflow docs_page (path="docs/cli.md", mode="strict")`
- `·   ▸ prompt prompt (topic="configuration")`
- `·   ▸ function changed_files (base="main")`

**Formatting rules:**
- Parameter segment is printed right after the node name, in gray.
- Format as comma-separated `key=value` pairs inside parentheses.
- Truncate each rendered parameter value to max 32 visible chars; append `...` when truncated.
- Preserve stable parameter order (parser/runtime order) so repeated runs are diff-friendly.
- If no parameters are passed, keep current output unchanged.

**Files to change:**
- `src/cli/commands/run.ts` (or tree renderer path) — include parameter suffix in displayed labels with ANSI gray styling.
- runtime/event payload source for step metadata (where function/workflow/prompt args are emitted) — ensure parameter map/list is available to renderer.
- tests for tree rendering with/without parameters and truncation edge cases.

**Acceptance criteria:**
- In tree output, `workflow`, `prompt`, and `function` nodes show passed parameters inline in gray.
- Each parameter value is capped at 32 chars in display output, with clear truncation marker.
- Existing tree output remains unchanged for nodes without parameters.
- Snapshot/unit tests cover ANSI output and non-color-safe fallback behavior (if applicable).

---

## 10. Shorten CI failure feedback and avoid hidden prompt handoff

**Status:** pending

**What:** Reduce "looks stuck" time in `ensure_ci_passes` by making e2e failure cases deterministic/fast and by clearly signaling when control moved from a failed rule to `prompt` remediation.

**Why:** Current runs can appear hung for 5-10 minutes because:
- some e2e paths depend on real backend behavior and can take ~60-90s before failing/passing,
- after a rule fails, workflow immediately starts prompt remediation, but tree/log focus can still look like the previous rule.

**Files to change:**
- `e2e/tests/40_nested_and_native_tests.sh` — make unmatched-mock case deterministic and fast (no dependency on external backend availability/latency).
- `src/runtime/steps.sh` + `src/runtime/prompt.sh` — emit explicit handoff markers (e.g. "starting remediation prompt after <rule> failure") and optional heartbeat while waiting on backend output.
- `src/cli/commands/run.ts` (if needed) — improve progress rendering when next active step is `jaiph::prompt`.
- docs in `docs/configuration.md` / `docs/cli.md` — document any timeout/heartbeat knobs added.

**Acceptance criteria:**
- `e2e_tests_pass` failure path finishes quickly and reproducibly on clean machines (no backend-dependent 60s+ wait in unmatched-mock test).
- When `ensure_ci_passes` transitions from failed rule to prompt remediation, logs make this transition obvious without opening multiple files.
- During long prompt waits, user sees periodic progress output (or explicit timeout) instead of silent freeze.
- Full test suite remains green.

---

## 9. Support Claude CLI as prompt backend

**Status:** pending

**What:** Add support for using Claude CLI as an alternative backend for `prompt` execution in Jaiph workflows, with a file-level default backend (`agent.backend`) and env fallback.

**Why:** Users should be able to run the same workflows with different agent CLIs without rewriting workflow logic.

**Files to change:**
- `src/jaiph_stdlib.sh` + `src/runtime/prompt.sh` — route prompt execution through a backend abstraction.
- `src/cli/commands/run.ts` + `src/parse/metadata.ts` + `src/types.ts` — expose file-level `agent.backend` and env fallback.
- `docs/cli.md` + `docs/configuration.md` — document backend selection and Claude CLI requirements.
- tests for backend dispatch, missing binary errors, and prompt mocks in test mode.

**Acceptance criteria:**
- User can set backend per workflow file via `agent.backend = "cursor|claude"`.
- Environment variable can override file default with deterministic precedence (env > file default > built-in default).
- No prompt-level backend override syntax is introduced in this task.
- Existing default backend remains unchanged and backward compatible
- Output capture (`result = prompt "..."`) continues to work with Claude CLI backend
- Clear error if Claude CLI is selected but unavailable
- In `jaiph test`, prompt mocks override backend execution; when a prompt is not mocked, selected backend executes normally (including Claude CLI)
- Prompt behavior (`stdout`/`stderr` capture and step event labels) stays consistent across backends

---

## 6. Project-local stdlib version pinning

**Status:** pending

**What:** Allow a project to pin Jaiph stdlib version via in-file metadata (for example `run.stdlib_version = "0.2.3"`). `jaiph run` should resolve/download cached stdlib for that version.

**Files to change:**
- `src/parse/metadata.ts` + `src/types.ts` — add and validate `run.stdlib_version`.
- `src/cli/commands/run.ts` — resolve stdlib path from metadata; download/cache to `~/.cache/jaiph/stdlib/<version>/jaiph_stdlib.sh`; set `JAIPH_STDLIB`.
- `docs/configuration.md` — document metadata key and precedence with env override.
- tests for cache hit/miss and invalid version error handling.

---

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

---

## 5a. Typed `prompt` schema validation with `--returns`

**Status:** pending

**What:** Add `--returns '{ ... }'` syntax on prompt assignment and validate returned JSON against declared fields/types.

**V1 scope constraints:**
- Schema is flat only (no nested objects)
- No arrays or union types in v1
- Supported field types are only `string`, `number`, `boolean`
- The expected type is injected at the end of the prompt, then the runtime parses the last line (lines?) to extract json. If something is malformated, the prompt fails.

**Syntax:**
```
result = prompt "Analyse the diff and classify the change" --returns '{
  type: string,
  risk: string,
  summary: string
}'
```

Allow multiline prompt + typed schema in bash style with line continuation:
```
result = prompt "Analyse the diff and classify the change" \
  --returns '{
    type: string,
    risk: string,
    summary: string
  }'
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

---

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

---

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

---

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
