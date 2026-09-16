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

## Drop run keyword; invoke is a bare call; stdin is stdin expr -> call() #dev-ready

Target language (this is the whole contract; do not keep a `run` alias):

- `save(path)` — invoke a def or named script (was `run save(path)`).
- `const x = save(path)` and `return save(path)` (was `const x = run save(path)`, `return run save(path)`).
- `async save(path)` and `const h = async save(path)` (was `run async save(path)`).
- `` `echo hello`() `` and `` const x = `echo hello`() `` (was `run \`echo hello\`()`).
- `save(path) catch (e) { … }` / `save(path) recover (e) { … }` / `save(path) allow_failure`.
- Nested call: `foo(bar())` (was `foo(run bar())`).
- Interpolation capture: `log "got: ${greet()}"` (was `${run greet()}`).
- Send payload call: `send save(path) -> channel` (was `send run save(path) -> channel`).
- Stdin connect (script target only): `stdin content -> save(path)`.
  Operand is a string value: bare ident, `${…}`, or double-quoted.
  Formatter canonical form: `stdin "${content}" -> save(path)`.
- `const out = stdin content -> save(path)`.
- `stdin content -> save(path) catch (e) { … }` and the same with `recover` / `allow_failure`.
- `stdin content -> `cat`()`.
- `async` plus stdin is `E_PARSE` (`stdin x -> async save(path)` and `async stdin …` are both illegal).
- Stdin dest that is a def or prompt is `E_VALIDATE`.
- `run` is not a keyword. `run save(path)` is `E_PARSE`. A symbol may be named `run` (`run()` is a call of that symbol).
- Do not revive def-body inline shell. A line that is not a managed form stays rejected at validate (send may still carry a shell payload).
- CLI `jaiph run` and config `run.recover_limit` are unchanged.

Do this in the compiler/runtime/format/tests:

- Parser (including `${…}` inline captures, const RHS, return, send RHS).
- Validator messages that mention `run` as the invoke keyword.
- Formatter emit of calls and the stdin connect form.
- Runtime only if the AST shape must change; prefer the existing exec+stdin field.
- All in-repo tests that compile or run `.jh` **except** `.jaiph/**`: unit, compiler txtar, golden AST, integration, e2e, samples.

Do not edit `.jaiph/**` (orchestration is updated outside this task). Do not edit published `docs/**` pages, `docs/index.html`, `docs/assets/js/main.js`, or `plugins/**` / `grammars/**` except if a test in the lanes above fails solely because it snapshots those files — then change the snapshot only.

Acceptance:

- A module with `export def main() { save("p") }` parses; the step is an exec call to `save`.
- `run save("p")` is `E_PARSE` (message must not tell the author to "use a script block" as if this were shell redirection).
- `stdin body -> save(path)` parses with `stdin` bound to the body expr and callee `save`.
- `stdin body -> helper()` where `helper` is a `def` is `E_VALIDATE`.
- `stdin body -> async save(path)` is `E_PARSE`.
- Formatter of `stdin content -> save(path)` emits `stdin "${content}" -> save(path)`.
- `npm run build`, `npm test`, and `npm run test:e2e` pass. When defined, `npm run arch:check` and `npm run lint` pass.
- CHANGELOG Unreleased records the language change (behavior only).

## Docs: language.md and grammar.md for bare calls and stdin connect #dev-ready

`docs/language.md` owns meaning. `docs/grammar.md` owns EBNF, reserved words, and the validation catalog. Follow `design/0003-docs-one-fact-one-owner.md`: state each fact once on its owner; do not paste the same rule onto both pages.

The language (restate so this task stands alone):

- Invoke is a bare call: `save(path)`, `const x = save(path)`, `return save(path)`, `async save(path)`, `` `echo hello`() ``.
- Stdin connect: `stdin content -> save(path)` (script only). Not a `run` suffix. Not shell `|`.
- `run` is not a keyword. CLI `jaiph run` and `run.recover_limit` stay.
- Catch/recover/allow_failure attach to the call (or to the connect form), not to a `run` keyword.
- `${greet()}` is the interpolation capture. Nested calls are `foo(bar())`.

Update every `run`-as-keyword example and table on those two pages. Add `stdin` to the reserved-word list if the parser reserves it; remove `run` from that list. Point other pages at these owners with one sentence and a link — do not rewrite how-tos in this task.

Do not edit `.jaiph/**`. Do not edit plugins or the www highlighter.

Acceptance:

- `docs/language.md` has no invoke example that uses a `run` keyword.
- `docs/grammar.md` reserved-word table does not list `run`; stdin connect is in the grammar.
- `integration/docs-structure.test.ts` still passes (caps and ownership).
- `npm test` passes.

## Docs: satellite pages and jaiph-skill after bare-call syntax #dev-ready

Published pages other than `docs/language.md` and `docs/grammar.md` still show `run` as an invoke keyword (tutorials, how-tos, `docs/async.md`, `docs/spec-async-handles.md`, `docs/jaiph-skill.md`, `docs/why-jaiph.md`, `docs/architecture.md` if it teaches surface syntax, `docs/index.html` sample snippets). Replace those examples with bare calls and `stdin expr -> call()`.

Follow `design/0003-docs-one-fact-one-owner.md`: do not restate the full stdin/call grammar. One sentence plus a link to `docs/language.md` (meaning) or `docs/grammar.md` (EBNF). `docs/jaiph-skill.md` stays a checklist.

CLI `jaiph run` examples stay. Config `run.recover_limit` stays.

Do not edit `.jaiph/**`, `docs/language.md`, `docs/grammar.md`, `docs/assets/js/main.js`, or editor grammars.

Acceptance:

- Grep of `docs/**/*.md` and `docs/index.html` finds `run` only as the CLI command, config key `run.*`, English verb, or a link/anchor that is not the old keyword.
- Embedded skill: `src/runtime/embedded-assets.test.ts` passes if `docs/jaiph-skill.md` changed (`npm run embed-assets` as required).
- `npm test` passes.

## Site highlighter: bare calls and stdin connect, drop run keyword #dev-ready

`docs/assets/js/main.js` tokenizes Jaiph for jaiph.org (`STATEMENT_KEYWORDS` includes `run`; a `firstValue === "run"` branch marks the callee).

Target language: invoke is `save(path)` / `async save(path)` / `` `echo hello`() ``; stdin is `stdin content -> save(path)`; `run` is not a keyword; CLI `jaiph run` in bash fences is unchanged.

Update the highlighter so `stdin` is a statement keyword, `run` is not, `async save(` highlights like the old `run async save(`, and `stdin content -> save(path)` highlights `stdin`, the operand, `->`, and the callee. Keep bash highlighting for `jaiph run`.

Do not edit `.jaiph/**` or the compiler.

Acceptance:

- `run` is absent from `STATEMENT_KEYWORDS`.
- `stdin` is in `STATEMENT_KEYWORDS`.
- No `firstValue === "run"` invoke special case remains (replace with bare-call / `async` / `stdin` connect recognition).
- `npm test` passes.

## Editor grammars: VS Code, Zed, tree-sitter for bare calls and stdin connect #dev-ready

Update `plugins/vscode/syntaxes/**`, `plugins/vscode/test/**`, `plugins/zed/languages/jaiph/**`, and `grammars/tree-sitter-jaiph/**` so highlighting matches:

- Bare call invoke: `save(path)`, `async save(path)`, `` `echo hello`() ``.
- Stdin connect: `stdin content -> save(path)` (`stdin` is a keyword; `->` is the connect arrow, same token class as `send … ->`).
- `run` is not a language keyword. Do not highlight `run` in `.jh` as `keyword.control`.
- `jaiph run` in markdown/bash injection stays a CLI command if those injections already highlight the CLI.

Do not edit `.jaiph/**`, `src/**`, or published docs except plugin READMEs if they show old `run` keyword examples.

Acceptance:

- VS Code grammar tests (`plugins/vscode/test/grammar.test.ts` and fixtures) pass with the new forms and without expecting `run` as a keyword.
- Zed `highlights.scm` / injections highlight `stdin` and do not list `run` as a keyword.
- Tree-sitter grammar parses `save(path)` and `stdin x -> save(path)` and rejects treating `run` as the invoke keyword (update corpus/tests in that package).
- `npm test` at the repo root still passes.
