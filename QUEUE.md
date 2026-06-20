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

## Docs redesign 8/8 — Post-parity cleanup: retire the legacy quarantine

> **Not `#dev-ready` — has a human precondition.** Before this task, the maintainer runs the redesign-aware parity workflow **by hand** on a clean worktree:
> `jaiph run .jaiph/docs_parity_redesign.jh`
> (a redesign-aware copy of `docs_parity.jh`: it lists docs recursively, excludes `docs/_legacy/`, and VERIFIES the Diátaxis structure against source instead of re-consolidating it — the stock `docs_parity.jh` would fight the new layout). The maintainer reviews and commits any doc edits it produces. **This queue task is the agent-doable cleanup that runs *after* that parity pass is green** — do not auto-pick it until the maintainer signals parity is done.

### Shared context

The `docs/` redesign (tasks 1–7, now landed) reorganized the site into Diátaxis quadrants per `.jaiph/skills/documentation-writer/SKILL.md`, writing pages greenfield from source while the originals sat quarantined in `docs/_legacy/` (build-excluded). **Source of truth = the TypeScript/Bash source + `docs/architecture.md`.** Parity against the implementation is verified out-of-band by the maintainer via `.jaiph/docs_parity_redesign.jh` (refuses to run on a dirty worktree; docs-only file allowlist).

### This task (runs after the maintainer's parity pass is green)

- Confirm the parity pass landed: the reference pages (`cli`, `configuration`, `grammar`, `language`, env-vars) match source exactly — run-dir naming, env-var lists, flag tables, config keys, error codes. Spot-check against source; if drift remains, the parity workflow was not actually run/committed — stop and report rather than hand-patching.
- **Delete `docs/_legacy/`** — its content has been fully superseded by the greenfield pages and is recoverable from git history. First confirm no published page (or `index.html`, nav, README) links into `docs/_legacy/`.
- Remove the now-unneeded `_legacy` entry from the Jekyll `exclude:` list in `docs/_config.yml`.
- Run the full check suite and a clean site build.

### Acceptance criteria (each verified by a test that fails when violated)
- `docs/_legacy/` no longer exists and no published page / nav / README / `index.html` references it (grep test fails if any `_legacy` reference remains).
- The docs-lint, internal-link, redirect-coverage, env-var source-parity, and nav-structure tests from tasks 2–7 are all green in `npm test`.
- `bundle exec jekyll build` exits 0 with no missing-link / front-matter warnings.
- No code behavior was changed in this task (cleanup + docs only).
