# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Docs redesign 4/8 — How-to guides: task-oriented recipes #dev-ready

### Shared context (repeated verbatim in every "Docs redesign" task so each is standalone)

The `docs/` site mixed all four Diátaxis types per page and is being restructured per `.jaiph/skills/documentation-writer/SKILL.md` (Tutorials = learning, How-to = recipes, Reference = lookup, Explanation = understanding). Author through the skill's workflow. **Source of truth = the TypeScript/Bash source + `docs/architecture.md`; verify against code.** `_site/` generated — never hand-edit. Nav in `docs/_layouts/docs.html`. Keep permalinks unless renamed; contributor docs grouped separately. Uses the `diataxis:` convention + harness from task 2.

**Anti-bias protocol:** pre-redesign pages are quarantined in `docs/_legacy/` (build-excluded) — except `architecture.md` and `jaiph-skill.md` (live). Write each new page **greenfield from source + `architecture.md` first**, then reconcile against `docs/_legacy/<page>.md`. Never edit a legacy copy in place.

**Target information architecture:** Tutorials (*first-workflow*, *first-agent-run*); How-to (install, sandbox-run, agent-auth, configure-backend, hooks, libraries, artifacts, testing); Reference (`cli`, `configuration`, `grammar`, `language`, env-vars); Explanation (`architecture`, sandboxing, `inbox`, `spec-async-handles`, *why-jaiph*); Contributor (`contributing`, `jaiph-skill`).

### This task

Create the How-to quadrant as discrete, problem-oriented recipes (each: goal → numbered steps → verification → links to reference/explanation; no conceptual digressions). Derive each from source, reconcile against the relevant `docs/_legacy/` page.
- **Install & switch versions** — from `_legacy/setup.md` (permalink `/setup`).
- **Run a workflow in a Docker sandbox** (overlay/copy/`inplace`, the confirm prompt, `JAIPH_INPLACE_YES`) — the enabling steps that were excluded from the task-3 sandboxing explanation.
- **Authenticate agent backends** (NEW) — claude (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`), cursor (`CURSOR_API_KEY` / login), codex (`OPENAI_API_KEY`); host vs Docker; the credential pre-flight, `E_AGENT_CREDENTIALS`, and the unsafe-mode skip. Verify against `src/cli/run/preflight-credentials.ts`.
- **Configure backend/model** — how-to slice of `_legacy/configuration.md`.
- **Add a hook** (`_legacy/hooks.md`); **Use & publish a library** (`_legacy/libraries.md`); **Save artifacts** (`_legacy/artifacts.md`); **Write & run tests** — how-to slice of `_legacy/testing.md`.
- Each recipe gets `diataxis: how-to`, a `/how-to/...` permalink, a `redirect_from` for any retired permalink (e.g. `/hooks`, `/libraries`, `/artifacts`), and a nav entry under a **How-to** group (finalized task 7).

### Acceptance criteria (each verified by a test that fails when violated)
- Each how-to page exists with `diataxis: how-to`, reachable from the nav; docs-lint (task 2) green.
- The agent-auth how-to names all three backends with their exact credentials and the error code — assert a content test greps for `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`, `E_AGENT_CREDENTIALS`.
- Every retired permalink (`/hooks`, `/libraries`, `/artifacts`, …) resolves via `redirect_from` (redirect-coverage check from task 2 fails otherwise); internal-link checker green.

***

## Docs redesign 5/8 — Reference pass: pure lookup pages, code-verified #dev-ready

### Shared context (repeated verbatim in every "Docs redesign" task so each is standalone)

The `docs/` site mixed all four Diátaxis types per page and is being restructured per `.jaiph/skills/documentation-writer/SKILL.md` (Tutorials = learning, How-to = recipes, Reference = lookup, Explanation = understanding). Author through the skill's workflow. **Source of truth = the TypeScript/Bash source + `docs/architecture.md`; verify against code.** `_site/` generated — never hand-edit. Nav in `docs/_layouts/docs.html`. Keep permalinks unless renamed; contributor docs grouped separately. Uses the `diataxis:` convention + harness from task 2.

**Anti-bias protocol:** pre-redesign pages are quarantined in `docs/_legacy/` (build-excluded) — except `architecture.md` and `jaiph-skill.md` (live). Write each reference page **greenfield from source first** (the code literally defines the flags / keys / grammar), then reconcile against `docs/_legacy/<page>.md`. Never edit a legacy copy in place; treat legacy tables as unverified hints.

**Target information architecture:** Tutorials (*first-workflow*, *first-agent-run*); How-to (install, sandbox-run, agent-auth, configure-backend, hooks, libraries, artifacts, testing); Reference (`cli`, `configuration`, `grammar`, `language`, env-vars); Explanation (`architecture`, sandboxing, `inbox`, `spec-async-handles`, *why-jaiph*); Contributor (`contributing`, `jaiph-skill`).

### This task

Build the Reference quadrant (after tasks 3–4 so what remains is genuinely reference). Each page is information-oriented: exhaustive, neutral, table-driven, no tutorials/recipes/opinion.
- Recreate `cli` (every command, flag, exit code), `configuration` (every config key, type, default, env equivalent, precedence), `grammar` (authoritative grammar), `language` (step types/expressions reference — any "why"/walkthrough prose goes to explanation).
- Create a consolidated **env-var reference** (`/reference/env-vars`) aggregating every `JAIPH_*` / `ANTHROPIC_*` / `CURSOR_*` / `CLAUDE_*` / `OPENAI_*` variable from source; other pages link here instead of re-listing. Absorb the sandboxing config/failure-mode tables excluded in task 3.
- Each page `diataxis: reference`; nav under a **Reference** group (finalized task 7).

### Acceptance criteria (each verified by a test that fails when violated)
- A source-parity test for the env-var reference: every `JAIPH_*` name read in `src/` (greppable `env\.JAIPH_[A-Z_]+` / `process.env.JAIPH_*`) appears in the table, and the page lists no variable absent from source — fails on drift in either direction.
- The reference pages contain no second-person tutorial prose / numbered walkthroughs (grep heuristic test).
- docs-lint + internal-link + redirect-coverage checks (task 2) all green.

***

## Docs redesign 6/8 — Tutorials: guided first-success paths #dev-ready

### Shared context (repeated verbatim in every "Docs redesign" task so each is standalone)

The `docs/` site mixed Diátaxis types per page; restructuring per `.jaiph/skills/documentation-writer/SKILL.md` (quadrants: Tutorials/How-to/Reference/Explanation). Author through the skill's workflow. **Source of truth = source + `docs/architecture.md`; verify against code.** `_site/` generated. Nav in `docs/_layouts/docs.html`. Keep permalinks unless renamed; contributor docs grouped separately. Uses the `diataxis:` convention + harness from task 2.

**Anti-bias protocol:** pre-redesign pages are quarantined in `docs/_legacy/` (build-excluded) — except `architecture.md` and `jaiph-skill.md` (live). Write each tutorial **greenfield from source first**, then reconcile against `docs/_legacy/getting-started.md`. Never edit a legacy copy in place.

**Target IA:** Tutorials (*first-workflow*, *first-agent-run*); How-to (install, sandbox-run, agent-auth, configure-backend, hooks, libraries, artifacts, testing); Reference (`cli`, `configuration`, `grammar`, `language`, env-vars); Explanation (`architecture`, sandboxing, `inbox`, `spec-async-handles`, *why-jaiph*); Contributor (`contributing`, `jaiph-skill`).

### This task

Build the learning quadrant last, on top of the now-clean how-to/reference pages it links into.
- **Your first workflow** — from `_legacy/getting-started.md` + source: install → write a minimal script-only `.jh` (no agent/keys) → `jaiph run` → read the output and `.jaiph/runs` artifacts. Every command copy-pasteable; one happy path; links out to reference rather than explaining options inline.
- **Your first agent + sandboxed run** (new) — add a `prompt` step, authenticate a backend (link the auth how-to), run it in the Docker sandbox. State credential prerequisites up front.
- Each tutorial: `diataxis: tutorial`, `/tutorials/...` permalink, nav under a **Tutorials** group (finalized task 7). `getting-started` becomes `tutorials/first-workflow` with `redirect_from: /getting-started` (or stays `/getting-started`, retyped) — pick one and add redirects.

### Acceptance criteria (each verified by a test that fails when violated)
- Both tutorials exist with `diataxis: tutorial`, reachable from nav; docs-lint green.
- A fenced-code extraction test runs the first-workflow tutorial's `.jh` snippet end-to-end (script-only, `JAIPH_UNSAFE=true` so no Docker/keys in CI) and asserts exit 0 + the documented output — the happy path is executable, not aspirational.
- If `/getting-started` is retired it resolves via `redirect_from` (redirect-coverage check fails otherwise); internal-link checker green.

***

## Docs redesign 7/8 — Navigation, landing page, redirects finalization #dev-ready

### Shared context (repeated verbatim in every "Docs redesign" task so each is standalone)

Restructuring `docs/` per `.jaiph/skills/documentation-writer/SKILL.md` (Diátaxis quadrants). `_site/` generated — never hand-edit. Nav is hand-maintained in `docs/_layouts/docs.html`. Keep permalinks unless renamed; contributor docs grouped separately. Uses the `diataxis:` convention + harness from task 2.

**Anti-bias protocol:** pre-redesign pages remain quarantined in `docs/_legacy/` (build-excluded). This task wires together the greenfield pages built in tasks 3–6; do not resurrect legacy pages into the site.

**Target IA:** Tutorials (*first-workflow*, *first-agent-run*); How-to (install, sandbox-run, agent-auth, configure-backend, hooks, libraries, artifacts, testing); Reference (`cli`, `configuration`, `grammar`, `language`, env-vars); Explanation (`architecture`, sandboxing, `inbox`, `spec-async-handles`, *why-jaiph*); Contributor (`contributing`, `jaiph-skill`).

### This task

Wire the finished structure together.
- Regroup `docs/_layouts/docs.html` nav into five labeled sections in this order: **Tutorials → How-to guides → Reference → Explanation → Contributing**, each listing exactly its pages (preserve active-page highlighting and the raw-`jaiph-skill.md` link behavior).
- Update `index.html` landing entry points to lead with the first tutorial and the how-to index (not a flat page list).
- Sweep every `redirect_from` so all retired/old permalinks (any URL in the pre-redesign nav) resolve to their new home.
- Rebuild the site (`bundle exec jekyll build`) and confirm a clean build.

### Acceptance criteria (each verified by a test that fails when violated)
- A nav-structure test asserts the nav contains the five section headings in order and that each published `diataxis:` page appears under the matching section exactly once (fails if a page is missing, miscategorized, or duplicated).
- Redirect-coverage check (task 2) passes for every historical permalink; the internal-link checker is green across the built site.
- `bundle exec jekyll build` exits 0 with no missing-link / front-matter warnings, and emits no page from `docs/_legacy/`.

***

## Docs redesign 8/8 — Pass `docs_parity.jh` + retire the legacy quarantine

> **Not `#dev-ready`:** this task requires a standalone `jaiph run .jaiph/docs_parity.jh` invocation (the `jaiph` CLI executing a `.jaiph/*.jh` workflow on a clean worktree), not just file edits. Run it manually / out-of-band after tasks 1–7 land; do not auto-pick it.

### Shared context (repeated verbatim in every "Docs redesign" task so each is standalone)

The `docs/` redesign (tasks 1–7) reorganized the site into Diátaxis quadrants per `.jaiph/skills/documentation-writer/SKILL.md`, writing pages greenfield from source while the originals sat quarantined in `docs/_legacy/` (build-excluded). **Source of truth = the TypeScript/Bash source + `docs/architecture.md`.** The repo has a `.jaiph/docs_parity.jh` workflow that verifies docs against the implementation; it **refuses to run on a dirty worktree** and restricts which files may change.

### This task

Make `.jaiph/docs_parity.jh` pass over the redesigned docs, then remove the quarantine.
- Commit the redesign (tasks 1–7) so the worktree is clean before running parity.
- Run `jaiph run .jaiph/docs_parity.jh` (host/unsafe is fine). Resolve every gap it reports by fixing the **docs** to match the code (code is source of truth) — unless it surfaces an actual code bug, in which case stop and report rather than papering over it in docs.
- Confirm run-dir naming, env-var lists, flag tables, config keys, and error codes in the reference pages match source exactly.
- **Delete `docs/_legacy/`** once parity is green — its content has been fully superseded and is recoverable from git history. (Confirm no live page links into `_legacy/`.)

### Acceptance criteria (each verified by a test that fails when violated)
- `jaiph run .jaiph/docs_parity.jh` completes with exit 0 on a clean worktree (the workflow is the failing-on-violation test).
- The docs-lint, internal-link, redirect-coverage, env-var source-parity, and nav-structure tests from tasks 2–7 are all green in `npm test`.
- `docs/_legacy/` no longer exists and no published page references it (grep test); `bundle exec jekyll build` exits 0.
- No code behavior was changed solely to satisfy docs (any code change is called out separately with justification).
