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

## How-tos stop restating cli.md contracts #dev-ready

Context: `design/0003-docs-one-fact-one-owner.md`. `docs/cli.md` already owns `jaiph mcp` exposure/naming, protocol, progress/cancel, hot reload, and `jaiph serve` endpoints plus auth. `docs/mcp.md` sections 3–7 and `docs/serve.md` steps 2–3 and 5 still paste those inventories. `integration/docs-how-to-caps.test.ts` caps mcp at 100 and serve at 120; the pages sit just under those caps, so a paste still fits.

Problem: a deriveTools rule or an HTTP endpoint change still needs two files. The how-to diet landed, but the recipes did not become “steps plus a link”.

Copies already gone (do not redo): `docs/jaiph-skill.md` is a checklist; `docs/grammar.md` no longer holds semantic tables; `--env` / sterile-script / `use` lives only on `docs/env-vars.md`.

Remediation — implement exactly this:

1. In `docs/mcp.md`, replace the inventories in sections 3–7 with one sentence plus a markdown link to `cli.md#jaiph-mcp` (or the matching `cli.md` heading). Keep numbered step headings, the Verification section, and Related. Keep the explicit heading id `{#7-stream-progress-and-cancel-a-long-call}` — `docs/cli.md` links to it.
2. In `docs/serve.md`, replace the endpoint catalog and the auth-mode inventory with one sentence plus a link to `cli.md#jaiph-serve`. Keep the curl recipes, numbered steps, Verification, and Related. Keep the explicit ids `{#7-authenticate-and-authorize}`, `{#deployment-topology}`, and `{:#9-bound-memory-over-a-long-lived-server}` — `docs/deploy.md` and `docs/cli.md` link to them.
3. Lower the caps in `integration/docs-how-to-caps.test.ts` to 80 (`mcp.md`) and 90 (`serve.md`) so a pasted inventory fails.
4. Do not edit `docs/cli.md` except to keep an inbound heading link resolving if you must rename a heading you kept. Do not edit `docs/jaiph-skill.md`, `docs/language.md`, `docs/grammar.md`, `docs/env-vars.md`, `docs/observability.md`, or `docs/agent-auth.md`.

### Copies are gone

When this task is accepted, **copies are gone**. That is the gate for the next queue task (lower body-line caps). It means:

- No non-owner page restates an owned inventory.
- The last remaining copies ADR 0003 named are these two: `mcp.md` deriveTools / protocol / progress / hot-reload (owner `cli.md#jaiph-mcp`) and `serve.md` endpoint catalog / auth-mode inventory (owner `cli.md#jaiph-serve`).
- After this task, a one-line change to deriveTools or an HTTP endpoint edits `cli.md` only.
- Skill inventories, grammar meaning tables, and the `--env` grant essay are already gone and must stay gone.

This task is not done if `mcp.md` still contains `deriveTools` or `additionalProperties: false`, or if `serve.md` still contains `GET /openapi.json` or `JAIPH_SERVE_OIDC_AUDIENCE`.

### Acceptance criteria

- `docs/mcp.md` body is `<= 80` lines and `docs/serve.md` body is `<= 90` lines (same front-matter strip as `integration/docs-how-to-caps.test.ts`). Today's pages must fail those caps until the inventories are gone.
- `docs/mcp.md` does not contain `deriveTools` or `additionalProperties: false`.
- `docs/serve.md` does not contain `GET /openapi.json` or `JAIPH_SERVE_OIDC_AUDIENCE`.
- `docs/mcp.md` still contains the heading id `7-stream-progress-and-cancel-a-long-call`. `docs/serve.md` still contains `7-authenticate-and-authorize`, `deployment-topology`, and `9-bound-memory-over-a-long-lived-server`.
- Both pages still have at least one numbered step heading and a `## Verification` heading, and still link to `cli.md`.
- `npm run build` and `npm test` pass.

## Lower docs body-line caps now that copies are gone #dev-ready

Context: `design/0003-docs-one-fact-one-owner.md` deferred lowering the 500-line cap until copies are gone (how-to 150, reference 350). Copies are gone when no non-owner page restates an owned inventory. The last copies were `docs/mcp.md` deriveTools / protocol / progress (owner `docs/cli.md#jaiph-mcp`) and `docs/serve.md` endpoint catalog / auth-mode inventory (owner `docs/cli.md#jaiph-serve`). Those are gone when `mcp.md` does not contain `deriveTools` or `additionalProperties: false`, and `serve.md` does not contain `GET /openapi.json` or `JAIPH_SERVE_OIDC_AUDIENCE`. Skill inventories, grammar meaning tables, and the `--env` grant essay are already gone.

If those literals are still present, stop. This task is not ready. Do not cut mcp/serve in this task.

Problem: `integration/docs-structure.test.ts` still uses `BODY_LINE_CAP = 500` for every page. That number fitted the pre-cut set. It does not enforce the post-copy sizes. A how-to can grow back an inventory and stay under 500.

Remediation — implement exactly this:

1. In `integration/docs-structure.test.ts`, replace the single 500-line cap with per-`diataxis` caps: how-to 150, reference 350. Tutorial, explanation, and contributor stay at 500.
2. Keep `language.md` on `DOC_SIZE_ALLOWLIST`. Add `cli.md` and `grammar.md` as single-owner inventories (one topic each; do not split them). Do not allowlist any how-to.
3. `docs/testing.md` (~160) and `docs/libraries.md` (~158) sit over 150. Cut restated inventories on those two pages only — one sentence plus a link to the owner (`cli.md`, `env-vars.md`, `configuration.md`, or `language.md`). Do not merge pages. Do not rewrite other how-tos.
4. Do not edit `docs/language.md`, `docs/cli.md`, `docs/grammar.md`, `docs/mcp.md`, `docs/serve.md`, or `docs/jaiph-skill.md`. Leave `integration/docs-how-to-caps.test.ts` as the tighter per-page guards for mcp/serve.

### Acceptance criteria

- `integration/docs-structure.test.ts` asserts how-to pages `<= 150` body lines and reference pages `<= 350` body lines (same front-matter strip as today's cap). A how-to of 151 lines that is not allowlisted must fail. A reference of 351 lines that is not allowlisted must fail.
- `DOC_SIZE_ALLOWLIST` contains `language.md`, `cli.md`, and `grammar.md`, each with a one-line single-owner justification. It does not contain `testing.md` or `libraries.md`.
- `docs/testing.md` and `docs/libraries.md` bodies are `<= 150` lines.
- `docs/mcp.md` still does not contain `deriveTools`. `docs/serve.md` still does not contain `GET /openapi.json`. If either string is present, fail this task rather than editing those files.
- Tutorial, explanation, and contributor pages still use the 500-line cap (`contributing.md` ~477 must still pass).
- `npm run build` and `npm test` pass.
