# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

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

## 12. Project-local `.jaiph/hooks.json` support (Cursor-style)

**Status:** pending

**What:** Add support for project-local hook configuration file at `.jaiph/hooks.json`, similar to Cursor hooks. Users should be able to create this file in their repo and define commands to run for relevant Jaiph lifecycle events.

**Why:** Gives a simple, explicit, repo-local integration point for custom automation (e.g. forwarding status to external tools like `jai`) without hardcoding destination logic in core runtime.

**Scope / behavior (V1):**
- Jaiph supports two hook config locations:
  - Global: `~/.jaiph/hooks.json`
  - Project-local: `<project>/.jaiph/hooks.json`
- Jaiph loads both when present, with deterministic precedence (project-local overrides global for conflicting event entries).
- If file exists and is valid JSON, Jaiph registers configured hook commands.
- Hook execution is best-effort: hook failure must not crash or block main workflow execution.
- Hook payload includes event metadata needed by external commands (workflow id, step id/name, status, timestamps, run path).
- If neither file exists, Jaiph behaves exactly as today.

**Files to change:**
- `src/cli/commands/run.ts` (or shared runtime path) — load/validate global + project hook files, merge with precedence, dispatch hooks for workflow/step events.
- `src/types.ts` — hook config and payload typing.
- docs (`docs/cli.md` or new hooks doc) — schema, supported events, precedence rules, examples for both file locations.
- tests for: valid config, missing file, invalid JSON, hook failure isolation, payload shape.

**Acceptance criteria:**
- A global `~/.jaiph/hooks.json` can define commands for supported Jaiph events.
- A repo-local `.jaiph/hooks.json` can define commands and override conflicting global entries.
- Hooks receive documented payload data and execute in event order.
- Invalid or failing hooks produce clear warnings/logs but do not fail workflow run.
- No behavior change when both hook files are absent.

---

## 11. Queue assignment capture for any step via `=`

**Status:** pending

**What:** Allow assignment capture syntax for any step, not just prompts, e.g. `response = ensure tests_pass`. This should capture the step's stdout into `response`.

**Why:** Enables composable workflows where arbitrary step output can be reused downstream with consistent shell mental model.

**Bash-consistent semantics (must match shell behavior):**
- Assignment capture does **not** change exit behavior by default: if the command fails, the step fails.
- If users want to continue on failure while still capturing output, they must write explicit short-circuiting (e.g. append `|| true`).
- stderr is **not** captured unless explicitly redirected by the workflow author (e.g. `2>&1`).
- Any future syntactic sugar for failure/stderr behavior is out of scope for this task.

**Files to change:**
- `src/parse/workflows.ts` — parse assignment form for generic steps.
- `src/transpile/emit-workflow.ts` — emit bash that captures stdout for assigned generic steps.
- `src/types.ts` and related step AST types — represent assignment target on non-prompt steps.
- tests (parser + transpiler + e2e) covering success, failure (`|| true`), and stderr redirection behavior.

**Acceptance criteria:**
- `response = ensure tests_pass` is valid and assigns stdout to `$response`.
- Failed command in assignment form fails workflow unless user explicitly writes `|| true`.
- stderr is excluded from capture unless command explicitly redirects it.
- Existing `result = prompt ...` behavior remains backward compatible.

---

## 10. Prompt line in tree: show prompt preview and cap arg length

**Status:** pending

**What:** Change how the prompt step is shown in the progress tree. Currently it displays only `▸ prompt (arg1)`. It should display: `▸ prompt "First 24 prompt chars..." (arg1)` — i.e. include a truncated preview of the prompt text (first 24 chars + "..." if longer). Additionally, cap the displayed argument list `(arg1)` to max 24 characters (e.g. truncate long args with "...").

**Why:** Makes it easier to tell which prompt is running when multiple prompts exist; keeps the tree line from growing unbounded with long args.

**Files to change:**
- `src/cli/run/progress.ts` (or wherever tree row labels for steps are built) — for prompt steps, include prompt text preview (24 chars max) and cap args to 24 chars in the label.
- Possibly `src/cli/commands/run.ts` if step labels are assembled when emitting step events.

**Acceptance criteria:**
- Tree line for a prompt step shows: `▸ prompt "<first 24 chars of prompt>..." (args)` when prompt is longer than 24 chars; no "..." when ≤24 chars.
- The `(arg1, arg2, ...)` part is at most 24 characters displayed (truncate with "..." if needed).
- Non-prompt steps unchanged.

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

## 5a. Typed `prompt` schema validation with `returns`

**Status:** pending

**What:** Add `returns '{ ... }'` syntax on prompt assignment and validate returned JSON against declared fields/types.

**V1 scope constraints:**
- Schema is flat only (no nested objects)
- No arrays or union types in v1
- Supported field types are only `string`, `number`, `boolean`
- The expected type is injected at the end of the prompt, then the runtime parses the last line (lines?) to extract json. If something is malformated, the prompt fails.

**Syntax (keyword `returns`, not `--returns` — DSL is keyword-based):**
```
result = prompt "Analyse the diff and classify the change" returns '{
  type: string,
  risk: string,
  summary: string
}'
```

Allow multiline prompt + typed schema in bash style with line continuation:
```
result = prompt "Analyse the diff and classify the change" \
  returns '{
    type: string,
    risk: string,
    summary: string
  }'
```

**Files to change:**
- `src/parse/workflows.ts` (prompt parsing path) — parse `returns { field: type, ... }` including `\` continuation.
- `src/transpile/emit-workflow.ts` — emit typed prompt call + schema payload.
- `src/jaiph_stdlib.sh` — schema-aware prompt helper + JSON validation.
- parser, transpile, and e2e tests for parse/type/missing-field error classes.

**Acceptance criteria:**
- Valid JSON response passes and exposes typed fields for extraction
- Missing field fails with clear field-specific schema error
- Invalid JSON fails with parse error
- Unsupported declared type fails with compile-time schema error
- Raw `$result` still contains the original JSON string
- Error classes are distinct and test-covered: parse error vs schema/type error vs missing-field error
- Testable with `jaiph test`: mock JSON response that satisfies the schema is accepted and typed fields are available
- Parser tests cover both single-line and multiline (`\`) `returns` forms

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
