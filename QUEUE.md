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

Remediation — implement exactly this:

1. In `docs/mcp.md`, replace the inventories in sections 3–7 with one sentence plus a markdown link to `cli.md#jaiph-mcp` (or the matching `cli.md` heading). Keep numbered step headings, the Verification section, and Related. Keep the explicit heading id `{#7-stream-progress-and-cancel-a-long-call}` — `docs/cli.md` links to it.
2. In `docs/serve.md`, replace the endpoint catalog and the auth-mode inventory with one sentence plus a link to `cli.md#jaiph-serve`. Keep the curl recipes, numbered steps, Verification, and Related. Keep the explicit ids `{#7-authenticate-and-authorize}`, `{#deployment-topology}`, and `{:#9-bound-memory-over-a-long-lived-server}` — `docs/deploy.md` and `docs/cli.md` link to them.
3. Lower the caps in `integration/docs-how-to-caps.test.ts` to 80 (`mcp.md`) and 90 (`serve.md`) so a pasted inventory fails.
4. Do not edit `docs/cli.md` except to keep an inbound heading link resolving if you must rename a heading you kept. Do not edit `docs/jaiph-skill.md`, `docs/language.md`, `docs/grammar.md`, `docs/env-vars.md`, `docs/observability.md`, or `docs/agent-auth.md`.

### Acceptance criteria

- `docs/mcp.md` body is `<= 80` lines and `docs/serve.md` body is `<= 90` lines (same front-matter strip as `integration/docs-how-to-caps.test.ts`). Today's pages must fail those caps until the inventories are gone.
- `docs/mcp.md` does not contain `deriveTools` or `additionalProperties: false`.
- `docs/serve.md` does not contain `GET /openapi.json` or `JAIPH_SERVE_OIDC_AUDIENCE`.
- `docs/mcp.md` still contains the heading id `7-stream-progress-and-cancel-a-long-call`. `docs/serve.md` still contains `7-authenticate-and-authorize`, `deployment-topology`, and `9-bound-memory-over-a-long-lived-server`.
- Both pages still have at least one numbered step heading and a `## Verification` heading, and still link to `cli.md`.
- `npm run build` and `npm test` pass.
