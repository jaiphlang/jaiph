# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## jaiph format is a no-op on shebang + const = prompt triple-quoted def #dev-ready

Context: `jaiph format` (`src/cli/commands/format.ts`) parses with trivia and re-emits via `emitModule` (`src/format/emit.ts`, `src/format/emit-steps.ts`). A `const name = prompt """ … """` step is a `const` whose RHS is `Expr.prompt`. Trivia on that expr carries `bodyKind: "triple_quoted"` and `rawBody` (author lines, including margin). Docs already state the contract: `docs/cli.md` (`jaiph format`) — shebang preserved, triple-quoted prompt blocks emit verbatim (author margin via trivia), a single blank line between steps is kept. `examples/say_hello.jh` uses this shape and `e2e/tests/128_examples_format_check.sh` checks every example, but no unit test pins the minimal file below. `src/format/emit.test.ts` has `const = prompt "…"` and top-level `const x = """`, not `const = prompt """` with a shebang.

Problem: this exact source is a normal first-agent file. Format must leave it bit-for-bit unchanged (default `--indent 2`). A rewrite that collapses `"""` to `"…"`, re-indents the prompt body, moves the closing `"""`, drops the shebang, or drops the blank line before `return` is a contract break. Today's suite can stay green while that happens.

Source that must be a no-op (trailing newline after `}`):

```
#!/usr/bin/env jaiph

export def hello(name) {
  const response = prompt """
    Say hello to ${name} and provide a fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}
```

Remediation — implement exactly this:

1. Add a unit test in `src/format/emit.test.ts`: `emitModule` of the def body (same steps, no shebang — shebang is CLI-only) equals the input bit-for-bit, including the 4-space prompt margin, the closing `"""` at 2 spaces, and the blank line before `return`.
2. Add a CLI / e2e check (`e2e/tests/100_format_command.sh` or a sibling): write the full source above (with shebang) and assert `jaiph format --check` exits 0 and `jaiph format` does not change the bytes. A second format pass is also a no-op.
3. If format currently rewrites this source, stop the rewrite. Do not collapse the prompt to a double-quoted string. Do not change `rawBody` / prompt trivia, recover bindings, or `stdin` in this task.

### Acceptance criteria

- Unit test: the `export def hello(name) { … }` body above (no shebang) round-trips through `parsejaiphWithTrivia` + `emitModule` with `assert.equal` to the original string. A formatter that emits `prompt "Say hello…"` or re-indents the two body lines must fail this test.
- `jaiph format --check` on a file whose entire contents are the shebang source above exits 0. `jaiph format` on a copy leaves `cmp` equal.
- `${name}` stays as authored interpolation in the formatted file (not substituted, not escaped away).
- `npm run build` and `npm test` pass. If you add the e2e section, `npm run test:e2e` passes that file.

## Thin jaiph-skill.md to an agent checklist #dev-ready

Context: `docs/jaiph-skill.md` is a third language book (~493 lines) next to `docs/language.md` and `docs/grammar.md`. It is also the body `jaiph init` writes to `.jaiph/SKILL.md`, via `src/runtime/embedded-assets.ts` (`JAIPH_SKILL_MD_BASE64`). `src/runtime/embedded-assets.test.ts` requires the embed to match the file on disk. `integration/sample-build/cli-tree.test.ts` only asserts the H1 `Jaiph Skill (for Agents)`. `e2e/tests/210_standalone_binary.sh` asserts the embedded `SKILL.md` matches `docs/jaiph-skill.md` byte-for-byte. Policy: `design/0003-docs-one-fact-one-owner.md`. The skill page is a checklist. Syntax lives in `docs/grammar.md`. Meaning lives in `docs/language.md`.

Problem: agents and the binary load a full restatement of `run`, `match`, `prompt`, interpolation, and `--env`. A language change then needs a third docs edit, and the embed drifts unless someone runs `npm run embed-assets`.

Remediation — implement exactly this:

1. Rewrite `docs/jaiph-skill.md` as an agent checklist. Keep the existing front matter (`title`, `permalink: /jaiph-skill`, `diataxis: contributor`, `redirect_from`). Keep the H1 `Jaiph Skill (for Agents)`.
2. Keep these sections and nothing else that restates an owned inventory: a one-paragraph lead that says this page is a checklist and that full rules live in `language.md` and `grammar.md`; the four-row construct table (`def`, `script`, `prompt`, `channel`); the smallest working example (the current `list_todos` / `export def main` sample or an equivalent that still compiles); a short authoring loop (`jaiph compile` then `jaiph run`); a short bullet list of authoring mistakes that point at the owner page (do not paste the owner rule); a Related list that includes `language.md`, `grammar.md`, `cli.md`, `configuration.md`, and `testing.md`.
3. Delete restated inventories: match-arm tables, `--env` / sterile-env essays, CLI flag lists, heartbeat / idle numbers, `StepDef` counts, reserved env key lists, named-prompt parameter rules, `run async` resolution tables. Replace each with one sentence and a markdown link to the owner in ADR 0003.
4. Body after front matter must be at most 120 lines. Count with the same rule as `integration/docs-structure.test.ts` (front matter excluded).
5. Run `npm run embed-assets` so `src/runtime/embedded-assets.ts` matches the new file. Do not edit `docs/language.md`, `docs/grammar.md`, `docs/cli.md`, `docs/env-vars.md`, or any how-to.

### Acceptance criteria

- A new test (prefer `integration/` next to the other docs tests) reads `docs/jaiph-skill.md`, strips front matter, and asserts the body has `<= 120` lines. Today's ~485-line body must fail this test until the rewrite.
- The same test (or a sibling) asserts the file still contains the H1 `Jaiph Skill (for Agents)`, a fenced `jaiph` example with `export def main`, and markdown links to `language.md` and `grammar.md`.
- The same test asserts the body does not contain these owner-owned strings: `E_ENV_RESERVED`, `JAIPH_NON_TTY_HEARTBEAT`, `StepDef`, `Handle<T>`.
- `src/runtime/embedded-assets.test.ts` still passes (`JAIPH_SKILL_MD_BASE64` equals the file on disk).
- `integration/docs-structure.test.ts` and `integration/docs-nav-structure-task7.test.ts` still pass (permalink, nav, summary-first lead).
- `npm run build` and `npm test` pass. If you touch the standalone embed path, `npm run test:e2e` passes `e2e/tests/210_standalone_binary.sh`.

## grammar.md keeps EBNF; language.md keeps meaning #dev-ready

Context: `docs/grammar.md` (~508 lines) and `docs/language.md` (~501 lines) repeat the same construct list (`run`, `catch` / `recover`, `prompt`, `const`, `return`, `send`, `log`, `if`, `match`, `for`, interpolation, step output). Grammar already has EBNF, lexical rules, file structure, and a validation catalog. Language already has semantic tables (resolution triggers, arm bodies, iterator scope). Policy: `design/0003-docs-one-fact-one-owner.md`. Syntax owner is `grammar.md`. Meaning owner is `language.md`.

Problem: a match or `run async` rule has to be edited in both files (and often in `jaiph-skill.md` too). The copies drift. This task does not edit `jaiph-skill.md`.

Remediation — implement exactly this:

1. In `docs/grammar.md`, keep lexical rules, file structure, import/export syntax, channel syntax, config-block syntax, types, definition EBNF, call-site EBNF, def-body EBNF, the validation catalog, and build artifacts.
2. For each construct whose meaning is already a table in `docs/language.md` (`run` including `run async`, `catch` / `recover`, `prompt`, `const`, `return`, `send`, `log` / `fail`, `if`, `match`, `for`, interpolation, step output), delete the semantic table from `grammar.md`. Leave the EBNF. Add one sentence that points at the matching `language.md` heading (use the existing heading text so the link resolves).
3. Do not delete EBNF productions. The file must still contain these tokens as grammar, not only as prose: `run_stmt`, `run_async_stmt`, `match_stmt`, `for_lines_stmt`, `param_list`, `return_stmt`.
4. Body after front matter must be at most 380 lines (same front-matter strip as `integration/docs-structure.test.ts`). Today's 508-line file must not pass that cap until the tables are gone.
5. Do not rewrite `docs/language.md` except to add a single Related link to `grammar.md` if that link is missing. Do not edit `docs/jaiph-skill.md`, `docs/cli.md`, or how-tos. Do not merge the two pages.

### Acceptance criteria

- A new test (prefer `integration/`) strips front matter from `docs/grammar.md` and asserts `<= 380` body lines. The current page must fail this test until the cut.
- The same test asserts `docs/grammar.md` still contains `run_stmt`, `run_async_stmt`, `match_stmt`, `for_lines_stmt`, and `param_list`.
- The same test asserts `docs/grammar.md` contains markdown links to `language.md` for `match` and `run async` (or `run`).
- `docs/language.md` still has its semantic tables for `match` (arm delimiter / arm bodies) and `run async` (resolution trigger). This task does not move meaning onto grammar.
- `integration/docs-reference-task5.test.ts` still passes (permalink, nav, no how-to shape). `integration/docs-structure.test.ts` still passes.
- `npm run build` and `npm test` pass.

## How-tos drop restated inventories #dev-ready

Context: `docs/mcp.md` (~192 lines), `docs/serve.md` (~223), `docs/observability.md` (~192), and `docs/agent-auth.md` (~113) are how-tos that grew inventories. Policy: `design/0003-docs-one-fact-one-owner.md`. A how-to is numbered steps plus links. Inventories live on `docs/cli.md`, `docs/env-vars.md`, `docs/configuration.md`, and `docs/language.md`. `integration/docs-how-to-task4.test.ts` requires `agent-auth.md` to name `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`, `E_AGENT_CREDENTIALS`, and `claude setup-token`. That test does not list mcp/serve/observability, but those pages should keep numbered steps and a Verification heading.

Problem: server and auth recipes restate flag lists, progress counters, principal tags, and credential essays that already have owners. A one-line CLI change then needs a how-to sweep.

Remediation — implement exactly this:

1. Rewrite only `docs/mcp.md`, `docs/serve.md`, `docs/observability.md`, and `docs/agent-auth.md` as recipes: goal, prerequisites, numbered step headings, Verification, Related. Keep existing front matter and permalinks.
2. Delete restated inventories (flag tables, MCP progress JSON dumps beyond one example, OTLP/Sentry field lists, `--env` essays). Replace each with one sentence and a link to the owner in ADR 0003.
3. `docs/agent-auth.md` must still contain the literals required by `integration/docs-how-to-task4.test.ts` (the five names above plus `claude setup-token`). Keep those as the recipe, not as a second env-vars table.
4. Body after front matter, counted as in `integration/docs-structure.test.ts`: `mcp.md` <= 100, `serve.md` <= 120, `observability.md` <= 100, `agent-auth.md` <= 100. Today's pages must fail those caps until the cut.
5. Do not edit `docs/jaiph-skill.md`, `docs/grammar.md`, `docs/cli.md`, `docs/env-vars.md`, or `docs/language.md`. Do not merge pages. Do not add a new how-to.

### Acceptance criteria

- A new test (prefer `integration/`) strips front matter and asserts the four body-line caps above. Current `mcp.md` / `serve.md` / `observability.md` bodies must fail until rewritten.
- Each of the four pages still has at least one `## N.` or `### N.` step heading and a `## Verification` (or `## Verify`) heading.
- Each of the four pages contains a markdown link to its owner (`cli.md` or `env-vars.md` or `configuration.md` as fits the page).
- `integration/docs-how-to-task4.test.ts` still passes (`agent-auth` literals, recipe shape for the pages it lists).
- `integration/docs-structure.test.ts` still passes (permalink, nav, summary-first lead).
- `npm run build` and `npm test` pass.

## --env has one essay, on env-vars.md #dev-ready

Context: The `--env` / sterile-script / `use` grant rule is restated in `docs/cli.md` (the `--env` flag cell), `docs/why-jaiph.md` (commitment 2), `docs/language.md` (Subprocess environment), and `docs/testing.md` (Grant use keys). The owner is `docs/env-vars.md` (`#script-env` and the reserved-key paragraph). Policy: `design/0003-docs-one-fact-one-owner.md`. `docs/script-env.md` is the how-to and may keep numbered steps. It must not paste the reserved-key list or the runner-allowlist essay.

Problem: a grant-rule change needs a sweep of those pages. Yesterday's docs commit touched eight files for one `--env` sentence.

Remediation — implement exactly this:

1. In `docs/cli.md`, replace the `--env` table cell essay with at most two sentences plus a link to `env-vars.md#script-env`. Keep the flag name, the `KEY=VALUE` / `KEY` forms, and `E_ENV_MISSING` / `E_ENV_RESERVED` as names only.
2. In `docs/why-jaiph.md`, keep the commitment that spawn-env is not a sandbox. Cut the grant mechanics. Link to `env-vars.md#script-env` and `script-env.md`.
3. In `docs/language.md`, replace the Subprocess environment bullet inventory with one short paragraph and a link to `env-vars.md#script-env`. Keep the sentence that module `const` values are not auto-exported (that is language, not env inventory).
4. In `docs/testing.md`, keep the `--env` how-to steps if they are steps. Delete any restated reserved-key or runner-allowlist paragraph. Link to `env-vars.md#script-env`.
5. In `docs/script-env.md`, keep the recipe. Delete any reserved-key list that duplicates `env-vars.md`. Link there.
6. Do not edit `docs/env-vars.md` except to add a Related link if one of the cut pages is missing. Do not edit `docs/jaiph-skill.md` or `docs/grammar.md`.

### Acceptance criteria

- A new test (prefer `integration/`) asserts `docs/cli.md` `--env` cell (the table row that begins with `| \`--env\``) is at most 400 characters, and that the row still contains `env-vars.md`.
- The same test asserts `docs/why-jaiph.md`, `docs/language.md`, and `docs/testing.md` each contain a markdown link to `env-vars.md`, and that none of those three files contains the literal `JAIPH_ENV_GRANT_FILE`.
- `docs/env-vars.md` still contains the script-env contract (`#script-env` or the sterile-script paragraph) and the reserved-key list including `JAIPH_ENV_GRANT_FILE`.
- `integration/docs-reference-task5.test.ts` still passes (env-vars src-parity, no how-to shape on reference pages).
- `npm run build` and `npm test` pass.
