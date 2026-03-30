# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   - breaking changes are allowed,
   - backward compatibility is **not** a design goal unless a task explicitly says otherwise.

---

## CI: Getting started (local Jekyll, no matrix) <!-- dev-ready -->

**Goal**  
Add a CI job **Getting started (local)** that mirrors **E2E install and CLI workflow** intent (install CLI, smoke workflow) but **without** an OS matrix, and **without** hitting `jaiph.org` — instead **start Jekyll locally** and use **`http://localhost:4000`** (or configured port) as the base URL.

**Context**

- Existing E2E uses `npm run test:e2e` on multiple OSes; this job is a **single-platform** smoke that validates the **docs site** can be served locally and prepares for **sample verification** against the live HTML.
- Future tasks will curl/fetch the served site; this job establishes Jekyll up + local URL.

**Key files:**
- `.github/workflows/ci.yml` — new job
- `docs/` — Jekyll config and Gemfile if needed
- `package.json` — optional script to `bundle exec jekyll serve` in CI (background) + health check

**Scope**

1. Add job **Getting started (local)** (e.g. `ubuntu-latest` only, no `strategy.matrix`).
2. Install Ruby/Jekyll deps, build or serve site, wait until `localhost:4000` responds.
3. Optional minimal check: fetch `/` or `/index.html` with `curl` and assert 200 (or Playwright smoke).
4. Document port and command in `docs/` or contributor notes.

**Acceptance criteria**

- CI runs the new job on each push; it passes when Jekyll serves locally.
- No dependency on `jaiph.org` in this job (local URL only).

---

## Verify landing-page samples (Playwright + local Jekyll) <!-- dev-ready -->

**Goal**  
Automatically verify that **samples shown on the site** match **real execution**: serve the site locally, reproduce **Try it out**, then for each sample **fetch** snippet/output from the page, **run** the corresponding workflow locally, and **compare** stdout (and stable fragments of stderr / tree output) to the **expected output embedded** in the page.

**Context**

- Checked-in **`.jh`** sources under `examples/` should mirror the page (see **`examples/`** queue item); this task may add `data-*` attributes to `docs/index.html` for stable extraction.
- Flow (single script or Playwright test suite):
  1. Start local Jekyll; base URL `http://localhost:4000` (or configured port).
  2. Run the **Try it out** inline workflow the same way the landing page documents (e.g. `curl ... | bash -s '...'` or equivalent) and assert success.
  3. For **sample 1, sample 2, …**: open the landing page, **extract** each sample’s code and **expected run output** from the DOM (e.g. **Playwright** + selectors / `data-sample` ids).
  4. Run the corresponding file from `examples/` with deterministic mocks/env; capture CLI output.
  5. **Match** captured output to the expected block from the page (normalize whitespace, strip volatile timestamps/paths where documented).

**Key files:**
- `e2e/` or `tests/e2e-samples/` — Playwright spec + helpers
- `package.json` — `@playwright/test` (or project choice), scripts
- `examples/` — files under test
- `docs/index.html` — selectors / structure stable enough for extraction (add `data-sample` attributes if needed)

**Scope**

1. Add Playwright (or agreed browser automation) to dev/CI deps.
2. Implement extraction of per-tab sample source and **expected run output** from the served HTML (prefer stable `data-*` hooks on sections).
3. For each sample: run Jaiph with deterministic mocks/env so outputs match embedded expectations (same strategy as other e2e).
4. Integrate into CI: same workflow file may add a job or extend **Getting started (local)**; document a one-command local run (`npm run test:samples` or similar).

**Acceptance criteria**

- Automated test fails if a landing-page sample output drifts from actual CLI behavior (within defined normalization).
- Uses localhost + Playwright (or documented equivalent) to fetch page content; no `jaiph.org` dependency for this verification step.

---

## `examples/` — landing-page samples as runnable files <!-- dev-ready -->

**Goal**  
Add an `examples/` directory (repo root or under `docs/`, pick one convention) containing **every** code sample from `docs/index.html` as real `.jh` (and related) files that can be executed.

**Context**

- Samples on the site are copy-pasted; drift between docs and actual behavior is likely without checked-in sources of truth.
- Each tab / block in **Samples** (e.g. `say_hello`, tests, `ensure_ci_passes`, inbox, async) should map to files under `examples/` with stable names.

**Key files:**
- `docs/index.html` — source list of samples to mirror
- `examples/` — new tree (structure documented in README or `docs/`)
- `e2e/tests/` — invoke `jaiph run` / `jaiph test` against `examples/` paths

**Scope**

1. Create `examples/` and add one file per landing-page sample (or minimal file set with imports), matching semantics of the HTML snippets.
2. Wire **e2e** tests that call Jaiph against these paths (non-interactive; mock prompts where needed so CI is deterministic).
3. Cross-link from `docs/index.html` or getting-started docs to `examples/` on GitHub.

**Acceptance criteria**

- Every major sample block on the landing page has a corresponding file under `examples/`.
- E2E exercises the examples tree; failures indicate doc/runtime drift.

---

## Dot notation for typed prompt fields `${var.field}` <!-- dev-ready -->

**Goal**  
Support field access syntax for typed prompt captures.

**Context**

- Underscore-concatenated names (`$response_message`) are ambiguous and non-obvious.
- The `interpolate()` function in `node-workflow-runtime.ts` (line ~69) currently matches `${identifier}` and `$identifier` — no dot notation.

**Key files:**
- `src/runtime/kernel/node-workflow-runtime.ts` — `interpolate()` (line ~69)
- `src/parse/steps.ts` — string parsing
- `src/transpile/validate.ts` — validation (check field against prompt schema)

**Scope**

1. Parse `${identifier.field}` in interpolation.
2. Validate `field` against prompt schema for `identifier`.
3. Implement deterministic runtime mapping to existing storage format.
4. Update docs and tests.

**Acceptance criteria**

- `${response.message}` works in all interpolation contexts.
- Invalid field names fail at validation time with actionable errors.

---

## Auto-detect model for selected backend <!-- dev-ready -->

**Goal**  
Auto-select a usable model when explicit model is missing/unavailable.

**Context**

- Hard failures on unavailable model names reduce usability and increase support burden.
- Model selection currently happens in `src/runtime/kernel/prompt.ts` and config resolution.

**Key files:**
- `src/runtime/kernel/prompt.ts` — prompt execution, model selection
- `src/runtime/kernel/node-workflow-runtime.ts` — config resolution
- `docs/configuration.md` — model configuration docs

**Scope**

1. Implement provider-specific model discovery policy.
2. Selection order:
   - explicit and available → use,
   - explicit but unavailable → fallback by policy,
   - missing → choose default compatible model.
3. Emit diagnostics showing selected model and why.
4. Add tests for all selection paths.
5. Update docs with override + fallback behavior.

**Acceptance criteria**

- Run/test succeeds without explicit model when compatible model exists.
- Selection/fallback decisions are visible in diagnostics.
- No-compatible-model path is actionable.

---

## Show prompt backend/model in run tree <!-- dev-ready -->

**Goal**  
Render prompt backend/model inline in tree output (`prompt <backend> "<preview>"`).

**Context**

- Mixed-backend runs are hard to debug from live tree alone.
- Prompt step start is emitted in `node-workflow-runtime.ts` via `emitPromptStepStart` (~line 291) which already has access to `backend` and the prompt text.
- The tree label is constructed in `src/cli/run/progress.ts` via `formatPromptLabel` (line ~122).
- Live TTY rendering is in `src/cli/run/stderr-handler.ts`.
- Non-TTY rendering is also in progress/display paths.

**Key files:**
- `src/cli/run/progress.ts` — `formatPromptLabel`, prompt step rendering (line ~122)
- `src/cli/run/stderr-handler.ts` — live TTY prompt display
- `src/runtime/kernel/node-workflow-runtime.ts` — `emitPromptStepStart` (~line 291), prompt event emission
- `src/cli/run/events.ts` — event parsing

**Scope**

1. Extend prompt step rendering to include backend/model: `prompt cursor/gpt-5 "summarize the..."` format.
2. Pass backend/model info through the event pipeline (if not already in `PROMPT_START` event payload).
3. Apply the same format in both TTY and non-TTY modes.
4. Add tests in CLI display/event parsing paths.
5. Update docs/examples to match exact rendered format.
6. Update sample outputs in `docs/index.html`

**Acceptance criteria**

- Prompt lines include backend/model in live output.
- Display is readable and consistent in TTY/non-TTY.

---

## Add Codex backend support <!-- dev-ready -->

**Goal**  
Support `codex` as a first-class prompt backend via the OpenAI Codex API.

**Context**

- Current runtime supports `cursor` and `claude` backend paths. Backend selection happens via `agent.backend` config.
- Prompt execution lives in `src/runtime/kernel/prompt.ts`.
- Backend config resolution uses `resolveConfig` in the runtime.
- The Codex backend should use the OpenAI Codex API (default endpoint). Agent should discover the current API surface and implement accordingly.

**Key files:**
- `src/runtime/kernel/prompt.ts` — prompt execution, backend dispatch
- `src/runtime/kernel/node-workflow-runtime.ts` — `resolveConfig`, prompt step handling
- `src/types.ts` — config types, backend enum
- `docs/configuration.md` — backend configuration docs

**Scope**

1. Add backend config validation for `codex`.
2. Implement runtime adapter for prompt + schema-return flows using the OpenAI Codex API.
3. Match existing streaming/error/logging contract used by cursor/claude backends.
4. Add tests (unit + integration with mocks).
5. Update docs with setup + minimal example.

**Acceptance criteria**

- `agent.backend = "codex"` routes prompt execution correctly.
- Missing config (API key, etc.) fails with actionable errors.
- Structured `returns` works with codex.

---

## Direct `return run` / `return ensure` support <!-- dev-ready -->

**Goal**  
Allow `return run ...` and `return ensure ...` directly in workflows/rules.

**Context**

- Current syntax requires boilerplate capture then return:
  ```
  const result = run some_script
  return "$result"
  ```
- With direct return:
  ```
  return run some_script
  ```

**Key files:**
- `src/parse/steps.ts` — return step parsing
- `src/types.ts` — return step AST type (extend for managed call)
- `src/runtime/kernel/node-workflow-runtime.ts` — return step execution (~line 490)
- `src/transpile/validate.ts` — validate refs in return expressions

**Scope**

1. Extend parser/AST return expression forms to accept `run` and `ensure` as return value sources.
2. Reuse managed-call validation for ref resolution.
3. Implement runtime behavior equivalent to capture + return.
4. Add unit/acceptance/e2e tests.

**Acceptance criteria**

- Direct return forms execute correctly.
- Unknown ref errors remain deterministic.

---

## Reporting: detect SIGKILL-stalled runs <!-- dev-ready -->

**Goal**  
Mark runs as terminated when `WORKFLOW_END` never arrives due to hard kill.

**Context**

- Reporting server can leave killed runs in active state forever.
- Reporting code lives in `src/reporting/*`.
- Run state is tracked via `run_summary.jsonl` and `.jaiph/runs/` artifacts.

**Key files:**
- `src/reporting/` — reporting server and state management
- `src/runtime/kernel/emit.ts` — event emission (WORKFLOW_START/END)

**Scope**

1. Implement stale run detection using timeout + liveness signal.
2. Mark stale entries as terminated/failed in API/UI.
3. Add integration/e2e test: start run, SIGKILL, verify terminal state.

**Acceptance criteria**

- SIGKILL run transitions to terminal state automatically.
- Normal completed runs unaffected.

---

## Add `jaiph build` command (standalone binary) <!-- dev-ready -->

**Goal**  
Add a `jaiph build [file|path]` CLI command that builds a standalone Bun executable from a `.jh` project.

**Context**

- `npm run build:standalone` in `package.json` already works: it runs `tsc`, copies runtime assets, then `bun build --compile ./src/cli.ts --outfile ./dist/jaiph`.
- The user-facing command set is `run`, `test`, `init`, `use`, `report` — `build` is not yet exposed as a CLI subcommand.
- The old `jaiph build` (transpile `.jh` → `.sh`) was removed from user-facing CLI. The new `jaiph build` is a different command — it builds a standalone distributable binary.
- CLI commands live in `src/cli/commands/` — existing: `run.ts`, `test.ts`, `init.ts`, `use.ts`, `report.ts`.
- CLI usage/help is in `src/cli/shared/usage.ts`.

**Key files:**
- `src/cli/commands/` — add `build.ts`
- `src/cli/shared/usage.ts` — add `build` to help output
- `src/cli.ts` (or wherever CLI dispatch lives) — add `build` subcommand dispatch
- `package.json` — reference existing `build:standalone` script logic

**Scope**

1. Add `build` subcommand (`src/cli/commands/build.ts`) and CLI dispatch.
2. Default behavior: `jaiph build` (no args) builds from current directory (`./`).
3. Accept optional `[file|path]` argument to specify input.
4. Under the hood: reuse the existing standalone build logic (tsc + copy assets + bun compile).
5. Update `src/cli/shared/usage.ts` with the new command.
6. Add an e2e test that runs `jaiph build`, verifies the output binary exists and is executable.

**Acceptance criteria**

- `jaiph build` produces a standalone binary.
- `jaiph build path/to/project` works.
- Binary runs without Node installed.
- e2e test covers the build command and verifies the output binary.
- `jaiph --help` lists the `build` command.

---

## Add `jaiph format` command <!-- dev-ready -->

**Goal**  
Add an opinionated formatter for `.jh` files with in-place and check modes.

**Context**

- No built-in formatting command exists; style drifts and noisy diffs are common.
- CLI commands live in `src/cli/commands/`.
- The parser (`src/parser.ts`, `src/parse/*`) already produces a full AST that can be re-emitted.

**Key files:**
- `src/cli/commands/` — add `format.ts`
- `src/cli/shared/usage.ts` — add `format` to help output
- `src/parser.ts`, `src/parse/*` — parser used for formatting input
- `src/types.ts` — AST types for re-emission

**Scope**

1. Add `format` subcommand (`src/cli/commands/format.ts`) and CLI dispatch.
2. Parse → re-emit stable source formatting from AST.
3. Support:
   - `--indent <n>` (default `2`),
   - `--check` (non-zero when changes needed).
4. Preserve comments and fail fast on parse errors.
5. Add unit + e2e coverage.

**Acceptance criteria**

- `jaiph format file.jh` rewrites in place.
- `jaiph format --check` is CI-safe.
- Formatting is idempotent.

---

## Anonymous inline scripts in workflows/rules <!-- dev-ready -->

**Goal**  
Allow `script "..."` inline steps for trivial commands.

**Context**

- Named scripts are verbose for one-off operations:
  ```
  script do_thing { echo "done" }
  workflow default { run do_thing() }
  ```
- With inline scripts:
  ```
  workflow default { script "echo done" }
  ```

**Key files:**
- `src/parse/steps.ts` — add inline script step parsing
- `src/types.ts` — add inline script step AST type
- `src/runtime/kernel/node-workflow-runtime.ts` — execute inline script
- `src/transpile/build.ts` — generate deterministic script artifacts

**Scope**

1. Add AST/parser step for inline script body.
2. Generate deterministic script artifact names.
3. Support capture form (`const x = script "..."`).
4. Preserve shebang behavior for custom interpreters.
5. Add tests (unit + e2e).

**Acceptance criteria**

- Inline script steps execute with same isolation contract as named scripts.
- Generated script artifacts are deterministic.

---

## `script:node` / `script:python3` / … — interpreter syntax sugar <!-- dev-ready -->

**Goal**  
Allow optional `script:<tag>` forms that expand to a fixed shebang (e.g. `#!/usr/bin/env node`) so authors do not hand-write shebang lines for common interpreters.

**Context**

- Custom shebang in script bodies remains supported for arbitrary tooling.
- Sugar examples: `script:node name { ... }`, `script:python3 name { ... }` → appropriate `#!/usr/bin/env <runtime>` (exact mapping documented and tested).
- Lays groundwork for future first-class tags such as PowerShell (`script:pwsh` or similar) and Windows-friendly workflows.

**Key files:**
- `src/parse/scripts.ts` — parse `script:<identifier>` prefix before script name
- `src/transpile/build.ts` — emit generated script with implied shebang when tag present
- `src/types.ts` — AST: store interpreter tag on script def if needed
- `docs/` — document supported tags and escape hatch (raw shebang)

**Scope**

1. Define grammar: `script:<tag> <name> { ... }` alongside plain `script <name> { ... }`.
2. Maintain a small built-in map tag → shebang line (node, python3, …); reject unknown tags with a clear error or document extension point.
3. Tests: parse, emitted artifact shebang, execution smoke for at least node + one other.
4. Update docs and any samples that currently use manual shebang for those interpreters.

**Acceptance criteria**

- `script:node` (and agreed set of tags) produces correct shebang in generated artifacts.
- Plain `script` + manual shebang behavior unchanged.
- Unknown `script:foo` fails with an actionable diagnostic (or is explicitly extensible per product choice).

---

## Pattern matching on strings (Rust-style `match`) <!-- dev-ready -->

**Goal**  
Add `match` on string values with **string literals** and **JavaScript regex literals** as patterns, Rust-like syntax: `match <expr> { <pattern> => <body>, ... }`.

**Context**

- Only two pattern kinds: **string literals** and **regex literals** (e.g. `/[a-z]+/` — same as JS regex).
- **Exhaustiveness:** every `match` must include exactly **one** default arm using `_` (wildcard). Duplicate `_` arms are a compile-time error.
- **Evaluation order:** arms are processed **top to bottom**; the **first** matching arm runs and **only that arm** applies (no fall-through to later arms).
- No other pattern kinds (no numbers, destructuring, etc.) in this task.

**Key files:**
- `src/parse/*` — new statement/expression form for `match`
- `src/types.ts` — AST for match arms
- `src/runtime/kernel/node-workflow-runtime.ts` — evaluate subject, test patterns top-to-bottom, run selected arm only
- `src/transpile/validate.ts` — ensure exactly one `_`; validate regex literals

**Scope**

1. Parse `match x { "lit" => ..., /re/ => ..., _ => ... }`.
2. Validate: exactly one `_` arm; reject `match` with zero or multiple `_` at compile time.
3. Runtime: string equality for literal arms; `RegExp` test for regex arms; evaluate arms in source order, first match wins, no further arms run.
4. Tests: literals, regex, default arm, missing `_` / duplicate `_` rejected at compile time.
5. Docs: grammar + examples (ordering semantics).

**Acceptance criteria**

- Valid `match` runs with correct branch selection; only one arm executes.
- Missing `_` or more than one `_` is a compile-time error.
- Only string and `/.../` regex patterns allowed; invalid forms have clear errors.
