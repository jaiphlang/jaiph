# ADR 0003 — One fact, one owner (docs)

*Status: accepted*
*Date (UTC): 2026-09-15*

## Decision

Each contract in the published docs has one owner page. That page states the full rule. Every other page that needs the fact uses one sentence and a link.

The docs are not too many pages. They are too many copies of the same contract. A one-line behavior change must not require a sweep of eight files.

## Why

The published set is about 6,100 lines across 27 pages. Three pages teach the language (`language.md`, `grammar.md`, `jaiph-skill.md`). How-to pages such as `mcp.md` and `serve.md` grew into inventories. `--env` grant rules are restated in `cli.md`, `env-vars.md`, `why-jaiph.md`, `language.md`, `script-env.md`, `jaiph-skill.md`, `agent-auth.md`, and `testing.md`.

`integration/docs-structure.test.ts` caps a page at 500 body lines, which is today's maximum, so it does not prevent the copies. The task-N docs tests freeze the current page list. Merging pages would hide the owner. It would not remove the copies.

## Owners

| Fact | Owner |
|---|---|
| Syntax and EBNF | `docs/grammar.md` |
| What a construct means | `docs/language.md` |
| CLI flags and invocation | `docs/cli.md` |
| Environment variable inventory | `docs/env-vars.md` |
| Config keys and scopes | `docs/configuration.md` |
| Why and trade-offs | `docs/why-jaiph.md` |
| How to do one job | the matching how-to |

A how-to is numbered steps plus links. It does not restate an inventory. `async.md` and `spec-async-handles.md` stay a pair (recipe and model). `configure-backend.md` and `configuration.md` stay a pair (recipe and keys).

`docs/jaiph-skill.md` is an agent checklist. It is not a third language book. It ships inside the binary (`src/runtime/embedded-assets.ts`), so its size is paid by every `jaiph init` and every standalone build.

`docs/architecture.md` is the implementation map for contributors. Validator internals, visitor tables, and file-size justifications belong there or in `docs/contributing.md`, not on user how-tos.

## What is out

- Merging pages so the tree looks smaller
- Another accuracy sweep that retouches every page that mentions a rule
- A new how-to whose fact already has an owner
- Growing `architecture.md` with more validator essays
- Lowering the 500-line cap in the same change as a content cut. Lower the cap after the copies are gone (how-to 150, reference 350).

## Product filter

New docs prose lands only if it states a fact that has no owner yet, or it is a step in a how-to, or it is a one-sentence link to the owner.

A change that restates an owned fact is a reject. Point at the owner instead.

## Consequences

- `docs/agent-analyzability.md` points here as the docs ownership rule.
- `docs/jaiph-skill.md` shrinks to a checklist and keeps pointing at `language.md` and `grammar.md`.
- `docs/grammar.md` keeps EBNF, lexical rules, and the validation catalog. Semantic tables move out or become a sentence plus a link to `language.md`.
- How-tos such as `mcp.md`, `serve.md`, `observability.md`, and `agent-auth.md` drop restated inventories.
- `--env` has one essay, on `docs/env-vars.md`. `cli.md` and `why-jaiph.md` keep one sentence and a link.
- Queue tasks that implement this ADR are standalone. Each task names the files it may edit and the files it must not edit.
