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

## Feat: git-defined snapshot content — gitignored files never enter the sandbox #dev-ready

**Source:** FS-isolation redesign discussion (2026-07-23). Today the Docker sandbox clone copies the entire workspace except the runs dir (`cloneWorkspaceForSandbox`/`WorkspaceCloner`, `src/runtime/docker.ts:410-521`): `node_modules`, build outputs, and — critically — gitignored secret files (`.env`, `credentials.json`, `.npmrc` with tokens) all land inside the container, readable by prompt agents running with `--permission-mode bypassPermissions` on untrusted input. This is both a secret-exposure hole (the filesystem twin of the `trusted_envs` env-scoping work: the sanctioned path for a secret is explicit injection into trusted steps, not "it was lying in `.env`") and the dominant copy-speed cost (ignored artifact dirs are typically >90% of file count).

**Content policy (uniform across all platforms and clone mechanisms — what the agent sees must never depend on which copy mechanism ran):**

* For a git workspace, the snapshot contains exactly: files reported by `git -C <ws> ls-files -z --cached --others --exclude-standard`, plus the `.git/` directory wholesale (workflows need history and commit inside the sandbox — see the existing rationale comment at `docker.ts:483-485`, which stays). Nothing else — gitignored files are absent from the sandbox.
* **Do not reimplement gitignore semantics** (nested ignores, `!` negations, `.git/info/exclude`, global excludes). git is the only oracle: consume the `ls-files` output. Do not use rsync `--filter=':- .gitignore'` or a hand-rolled matcher — both diverge from git on negations.
* Non-git workspace (no `.git` at the workspace root or `git ls-files` fails): copy everything, current behavior. Document this fallback.
* Submodule directories are copied wholesale (a `.gitmodules`-registered path appears as a single gitlink in `ls-files`; recurse into it as an opaque directory copy). Document.
* Edge: `ls-files --cached` lists tracked files deleted from the worktree but not yet committed — skip paths that don't exist on disk.
* The existing runs-root exclusion (`docker.ts:497`) still applies on top (relevant for the non-git fallback and for `.git`-wholesale copying when the runs dir is nested unusually).
* Prune at directory granularity where the file list allows it (e.g. an entirely-ignored `node_modules/` never gets scanned/recursed) — the entry-by-entry recursion in `WorkspaceCloner.copyDir` (`docker.ts:500-511`) exists precisely to support subtree skipping.
* **No config escape hatch in this task.** A `sandbox.include`-style additive re-include was considered and deliberately deferred; do not add config surface. Consequence to document plainly in `docs/sandboxing.md`: the sandbox has clean-checkout-plus-untracked semantics — `node_modules` is absent, so workflows that build/test must install dependencies inside the container (same conditions CI sees).
* Applies to the Docker sandbox snapshot/clone path only (default mode). `--inplace` and host mode are untouched. No migration notes — hard rewrite; document only the new model.

Acceptance:

* e2e (or integration) test: in a git workspace with a tracked file, an untracked non-ignored file, a gitignored `.env`-style file, and a gitignored `node_modules/`-style directory — the container sees the first two, and the ignored file AND ignored directory are **absent** (not empty — absent). Assert on macOS-style clonefile path and the plain-copy path via the injectable spawn used by existing `WorkspaceCloner` tests, so the content set is proven mechanism-independent.
* Test: a nested `.gitignore` with a `!` negation (ignored dir, one re-included file) produces exactly git's answer inside the sandbox — proving the git oracle is used, not an approximation.
* Test: `.git/` is present and functional in the sandbox (`git -C /jaiph/workspace log -1` succeeds in-container, or equivalent host-side assertion on the clone).
* Test: non-git workspace falls back to copy-everything (an "ignored-looking" file is present).
* Test: a tracked-but-deleted-from-worktree file does not fail the clone.
* Docs updated: `docs/sandboxing.md` describes the content policy, the non-git fallback, submodule handling, and the install-deps-in-container consequence.
* `npm test` and `npm run test:e2e` pass.

***
