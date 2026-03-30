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

## Docs: Recreate `docs/getting-started.md` <!-- dev-ready -->

**Goal**  
Recreate the Getting Started page as the primary onboarding entry point.

**Context**

- File was deleted — needs recreation from source code truth.
- Target of the "Docs" link in site nav (`docs/index.html` line 36, `docs/_layouts/docs.html` line 46).
- Covers the "Running a workflow" section from Core Features (`docs/index.html` lines 438-453).

**Key files:**
- `docs/getting-started.md` — recreate
- `docs/index.html` — reference for content
- `README.md` — getting started section reference
- `src/cli/*` — source of truth for CLI behavior

**Scope**

1. Create with Jekyll front matter (`title: Getting started`, `permalink: /getting-started`, `redirect_from: /getting-started.md`).
2. Content: install, quick try (curl one-liner), running a workflow (arguments, workspace convention, run artifacts), `jaiph init`, language overview with links to grammar/CLI/config docs.
3. Structure rule: `# Getting Started` → overview paragraph (no sub-header) → `## Sections`.
4. Verify all CLI commands against source code.
5. Use `writer` role.

**Acceptance criteria**

- File exists with correct Jekyll front matter.
- Covers install, first run, workspace setup, and language overview.
- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All CLI examples verified against source code.

---

## Docs: Revisit `docs/grammar.md` — language concepts <!-- dev-ready -->

**Goal**  
Make grammar.md human-readable and structurally consistent — covers prompts, rules, scripts, async calls, and ensure/recover.

**Context**

- Currently starts with `## Overview` sub-header — should be headerless overview paragraph.
- Corresponds to the "Language" paragraphs in Core Features (`docs/index.html` lines 455-482): prompts with strict checks, bash/polyglot scripts, async calls, ensure/recover.
- Source code (`src/parse/*`, `src/runtime/kernel/node-workflow-runtime.ts`) is truth for language semantics.

**Key files:**
- `docs/grammar.md` — target
- `src/parse/*` — parser source of truth
- `src/runtime/kernel/node-workflow-runtime.ts` — runtime semantics
- `src/types.ts` — AST types
- `src/transpile/validate.ts` — validation rules

**Scope**

1. Fix structure: remove `## Overview` header, make overview a headerless paragraph after `# Grammar`.
2. Verify all language constructs against source code.
3. Ensure async calls, ensure/recover, and script isolation are clearly documented.
4. Make examples executable and aligned with current behavior.
5. Improve readability: reduce density, add section transitions, keep approachable.
6. Use `writer` role.

**Acceptance criteria**

- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All language constructs verified against parser and runtime source code.
- Readable by a developer new to the project.

---

## Docs: Revisit `docs/inbox.md` — agent inbox pattern <!-- dev-ready -->

**Goal**  
Make inbox.md human-readable and accurate — covers channels and dispatch.

**Context**

- Corresponds to "Agent inbox pattern (channels)" in Core Features (`docs/index.html` lines 473-478).
- Source code in `src/runtime/kernel/inbox.ts` and channel validation in `src/transpile/validate.ts`.

**Key files:**
- `docs/inbox.md` — target
- `src/runtime/kernel/inbox.ts` — inbox runtime
- `src/runtime/kernel/node-workflow-runtime.ts` — channel dispatch
- `src/transpile/validate.ts` — channel validation

**Scope**

1. Fix structure if needed: `# Header` → overview (no sub-header) → `## Sections`.
2. Verify channel declaration, send (`<-`), route (`->`), and dispatch semantics against source code.
3. Improve readability and examples.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure rule.
- All inbox/channel semantics verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/testing.md` <!-- dev-ready -->

**Goal**  
Make testing.md human-readable and accurate.

**Context**

- Corresponds to "Testing Jaiph workflows" in Core Features (`docs/index.html` lines 502-504).
- Currently starts with `## Overview` sub-header — should be headerless overview.
- Source code in `src/runtime/kernel/node-test-runner.ts`.

**Key files:**
- `docs/testing.md` — target
- `src/runtime/kernel/node-test-runner.ts` — test runner
- `src/parse/tests.ts` — test parsing
- `src/types.ts` — test AST types

**Scope**

1. Fix structure: remove `## Overview` header, make overview headerless.
2. Verify mock prompt, mock workflow/rule/script, assertions, and test execution against source code.
3. Improve readability and examples.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All test constructs verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/configuration.md` <!-- dev-ready -->

**Goal**  
Make configuration.md human-readable and accurate.

**Context**

- Corresponds to "Configuration" in Core Features (`docs/index.html` lines 497-500).
- Currently well-structured but dense — needs readability improvement.

**Key files:**
- `docs/configuration.md` — target
- `src/runtime/kernel/node-workflow-runtime.ts` — config resolution
- `src/cli/run/lifecycle.ts` — CLI config handling

**Scope**

1. Verify structure follows rule (currently OK — has headerless overview).
2. Verify all config keys, precedence, and env variable mappings against source code.
3. Improve readability: reduce density where possible, add practical guidance.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure rule.
- All config keys and precedence verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/hooks.md` <!-- dev-ready -->

**Goal**  
Make hooks.md human-readable and accurate.

**Context**

- Corresponds to "Hooks" in Core Features (`docs/index.html` lines 493-496).
- Currently well-structured with headerless overview.

**Key files:**
- `docs/hooks.md` — target
- `src/cli/run/hooks.ts` or wherever hooks are implemented
- `src/types.ts` — hook payload types

**Scope**

1. Verify structure follows rule (currently OK).
2. Verify all hook events, payload fields, and behavior against source code.
3. Improve readability where needed.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure rule.
- All hook behavior verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/reporting.md` <!-- dev-ready -->

**Goal**  
Make reporting.md human-readable and accurate.

**Context**

- Corresponds to "Reporting server" in Core Features (`docs/index.html` lines 485-489).
- Currently starts with `## Overview` with nested `### Problem and goals` — needs flattening.

**Key files:**
- `docs/reporting.md` — target
- `src/reporting/*` — reporting implementation
- `src/cli/commands/report.ts` — CLI report command

**Scope**

1. Fix structure: flatten overview, remove nested sub-headers under overview.
2. Verify reporting server features and CLI usage against source code.
3. Improve readability.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All reporting features verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/sandboxing.md` <!-- dev-ready -->

**Goal**  
Make sandboxing.md human-readable and accurate.

**Context**

- Corresponds to "Docker sandboxing" in Core Features (`docs/index.html` lines 490-492).
- Currently starts with `## Overview` sub-header — should be headerless overview.

**Key files:**
- `docs/sandboxing.md` — target
- `src/cli/run/` — Docker sandboxing implementation
- `docs/configuration.md` — `runtime.*` config keys

**Scope**

1. Fix structure: remove `## Overview` header, make overview headerless.
2. Verify Docker setup, mounts, env forwarding, and container behavior against source code.
3. Improve readability.
4. Use `writer` role.

**Acceptance criteria**

- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All sandboxing behavior verified against source code.
- Readable and approachable.

---

## Docs: Revisit `docs/cli.md` <!-- dev-ready -->

**Goal**  
Make cli.md human-readable and accurate.

**Context**

- Covers CLI commands, env variables, run progress, and tree output.
- Currently starts with `## Overview` sub-header — should be headerless overview.
- Also covers the "Running a workflow" section from Core Features (`docs/index.html` lines 438-453).

**Key files:**
- `docs/cli.md` — target
- `src/cli/*` — CLI implementation
- `src/cli/shared/usage.ts` — CLI usage text

**Scope**

1. Fix structure: remove `## Overview` header, make overview headerless.
2. Verify all CLI commands, flags, env variables, and tree output against source code.
3. Ensure consistency with `src/cli/shared/usage.ts`.
4. Improve readability.
5. Use `writer` role.

**Acceptance criteria**

- Follows structure: `# Header` → overview (no sub-header) → `## Sections`.
- All CLI behavior verified against source code and usage.ts.
- Readable and approachable.

---

## Docs: Revisit `docs/contributing.md` <!-- dev-ready -->

**Goal**  
Make contributing.md human-readable, without duplicating architecture content.

**Context**

- Currently well-structured with headerless overview.
- Should not duplicate content from `ARCHITECTURE.md` (being moved to `docs/architecture.md`).

**Key files:**
- `docs/contributing.md` — target
- `ARCHITECTURE.md` — architecture reference (being moved to docs/)
- `package.json` — build/test commands

**Scope**

1. Verify structure follows rule (currently OK).
2. Remove duplicated architecture content — link to architecture page instead.
3. Verify build commands, test instructions, and branch strategy against current repo state.
4. Improve readability where needed.
5. Use `writer` role.

**Acceptance criteria**

- Follows structure rule.
- No duplicated architecture content — links to architecture page.
- All build/test instructions verified and working.

---

## Docs: Move `ARCHITECTURE.md` to `docs/architecture.md` <!-- dev-ready -->

**Goal**  
Move architecture documentation into the docs site.

**Context**

- `ARCHITECTURE.md` lives at repo root — should be part of the docs site.
- Content should be generic architecture overview — remove anything that duplicates `docs/contributing.md`.
- Many docs pages reference `../ARCHITECTURE.md` — all need updating.

**Key files:**
- `ARCHITECTURE.md` — source (move to `docs/architecture.md`)
- `docs/_layouts/docs.html` — add to navigation
- `docs/contributing.md`, `docs/hooks.md`, `docs/configuration.md`, `docs/grammar.md`, `docs/cli.md`, `docs/sandboxing.md` — update `../ARCHITECTURE.md` references to `architecture.md`
- `README.md` — update reference

**Scope**

1. Move `ARCHITECTURE.md` to `docs/architecture.md`.
2. Add Jekyll front matter (`title: Architecture`, `permalink: /architecture`, `redirect_from: /architecture.md`).
3. Fix structure: `# Architecture` → overview (no sub-header) → `## Sections`.
4. Remove content duplicating `contributing.md` — keep only architectural concepts.
5. Add to navigation in `docs/_layouts/docs.html`.
6. Update all cross-references across docs and README.
7. Use `writer` role.

**Acceptance criteria**

- File at `docs/architecture.md` with correct Jekyll front matter.
- Added to site navigation.
- No duplicated content with `contributing.md`.
- All cross-references updated and working.
- Follows structure rule.

---

## Docs: Shorten and refocus `README.md` <!-- dev-ready -->

**Goal**  
Make README shorter, more general, and contribution/overview focused.

**Context**

- README is currently ~150 lines with detailed technical content that belongs in `docs/`.
- Should be an overview: what Jaiph is, quick install, one example, links to docs, contribution pointers.

**Key files:**
- `README.md` — target
- `docs/getting-started.md` — detailed getting started content
- `docs/` — all detailed docs

**Scope**

1. Keep: project description, badges, one concise example, install, quick try.
2. Remove: detailed feature descriptions, architecture details, long usage sections.
3. Add: clear links to docs/ for details (getting started, grammar, CLI, contributing).
4. Keep contributing section brief — link to `docs/contributing.md`.
5. Target: roughly half its current length.
6. Use `writer` role.

**Acceptance criteria**

- README is noticeably shorter and focused on overview + getting started.
- All detailed content linked to docs/ rather than duplicated.
- One clear example remains.
- Links to all important docs pages.

---

## Docs: Interlink all pages and add ToC with "you are here" <!-- dev-ready -->

**Goal**  
Add consistent navigation with active-page highlighting across all docs pages.

**Context**

- Docs pages are loosely connected — some have contextual links but no consistent ToC or active-page indicator.
- `docs/_layouts/docs.html` has a nav panel with page links but no "you are here" highlighting.
- Jekyll provides `page.url` / `page.permalink` which can be matched against link hrefs for active state.

**Key files:**
- `docs/_layouts/docs.html` — docs template with navigation
- `docs/assets/css/style.css` — navigation styles
- `docs/assets/js/main.js` — navigation behavior
- All `docs/*.md` — ensure consistent cross-links

**Scope**

1. Add active-page CSS class to current page link in `docs/_layouts/docs.html` (use Jekyll `page.permalink` matching).
2. Ensure all doc pages are in nav panel in logical order (Getting Started → Grammar → CLI → Configuration → Testing → Inbox → Hooks → Reporting → Sandboxing → Architecture → Contributing).
3. Style the active link distinctly ("you are here").
4. Verify all cross-references between docs pages are consistent.
5. Use `writer` role.

**Acceptance criteria**

- Current page is visually highlighted in navigation.
- All docs pages appear in navigation in logical order.
- Cross-references between pages are consistent and working.

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
- **Expression form:** `match` must be a valid **expression**, not only a standalone statement, so the value of the chosen arm is the value of the whole `match` — e.g. `return x match { ... }` (subject `x`, then `match { ... }` as the return value).
- **Mocks:** **Hard-remove** the `contains` keyword from `mock prompt { }` (no deprecation window). Prompt dispatch in `*.test.jh` should use the same **pattern matching** model (literals + regex + `_`) as workflows — no parallel substring / `contains` mini-language.

**Key files:**
- `src/parse/*` — new statement/expression form for `match`
- `src/types.ts` — AST for match arms
- `src/runtime/kernel/node-workflow-runtime.ts` — evaluate subject, test patterns top-to-bottom, run selected arm only
- `src/transpile/validate.ts` — ensure exactly one `_`; validate regex literals
- `src/parse/tests.ts`, `src/runtime/kernel/node-test-runner.ts` — delete `contains`-based mock prompt parsing/generation; replace with `match`-driven mock dispatch
- `docs/testing.md`, `docs/index.html` — mock prompt docs after migration

**Scope**

1. Parse `match x { "lit" => ..., /re/ => ..., _ => ... }`.
2. Validate: exactly one `_` arm; reject `match` with zero or multiple `_` at compile time.
3. Runtime: string equality for literal arms; `RegExp` test for regex arms; evaluate arms in source order, first match wins, no further arms run.
4. Implement **`match` as an expression**: each arm body produces a value; the `match` expression evaluates to the selected arm’s value (so `return x match { ... }` and assigning `y = z match { ... }` work).
5. **Mocks:** remove `if ${arg1} contains` / `elif ... contains` / `respond` (or equivalent) entirely; re-express `mock prompt { ... }` using pattern `match` on the prompt text (same pattern rules as workflow `match`), updating parser, generated dispatch, fixtures, and docs.
6. Tests: literals, regex, default arm, missing `_` / duplicate `_` rejected at compile time; returnable `match`; migrated mock tests with no `contains`.
7. Docs: grammar + examples (ordering semantics, expression form, mock prompt shape).

**Acceptance criteria**

- Valid `match` runs with correct branch selection; only one arm executes.
- Missing `_` or more than one `_` is a compile-time error.
- Only string and `/.../` regex patterns allowed; invalid forms have clear errors.
- **`return x match { ... }`** (and other expression positions) type-check / parse and return the matched arm’s value.
- **`contains` does not appear** in mock prompt syntax or test parser; prompt mocks use pattern `match` only.

---

## Unify string quoting across Jaiph <!-- policy TBD — not dev-ready -->

**Goal**  
One clear, documented rule for **single-quoted** vs **double-quoted** strings everywhere they appear (orchestration strings, `fail` / `log` / `logerr`, `mock prompt`, `const` / `local` RHS, test blocks, metadata, etc.), with parser and runtime aligned.

**Context**

- Today behavior is **inconsistent**: e.g. `fail` accepts only double-quoted reasons, while `mock prompt` accepts both; other forms differ. Authors cannot rely on a single mental model.
- **Approach is undecided** — options include: double-only for orchestration, symmetric single+double with identical semantics, reserved use (e.g. double = interpolate, single = literal), or something else. Product + grammar trade-offs need an explicit decision before implementation.

**Key files (once policy is chosen):**  
`src/parse/*`, `docs/grammar.md`, user-facing docs, fixtures, e2e.

**Scope**

1. Decide and document the quoting policy (short ADR or grammar section).
2. Align parsers, validators, and error messages.
3. Update tests and docs; accept breaking changes per queue rules.

**Acceptance criteria**

- Policy is written down; a reader can predict which quotes to use in any construct.
- Parser and runtime match that policy; no ad-hoc per-keyword exceptions unless explicitly documented as such.
