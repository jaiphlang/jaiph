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
