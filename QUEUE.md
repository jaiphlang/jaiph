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

## Release: bump version to 0.11.0 #dev-ready

Cut release **v0.11.0** from the current `# Unreleased` changelog block. The supported mechanical path is `.jaiph/prepare_release.jh`; the operator still reviews the diff, stamps the changelog, commits, tags, and pushes.

Steps:

1. Ensure the git tree is clean and `# Unreleased` in `CHANGELOG.md` contains every change shipping in this release.
2. Run `jaiph run .jaiph/prepare_release.jh -- 0.11.0` (bumps `package.json` + `package-lock.json`, refreshes the pinned `v0.10.0` → `v0.11.0` ref in **both** `docs/install` and `docs/install.ps1` in lockstep, rebuilds, asserts `jaiph --version` matches, regenerates `docs/registry`).
3. Stamp `CHANGELOG.md`: rename `# Unreleased` → `# 0.11.0`, add a `## Summary` section with 3–6 bullets capturing the headline themes (MCP server + Docker parity, `--env` passthrough, config interpolation + `agent.model` breaking changes, Windows portability/distro), keep the existing `## All changes` bullets under the new version header, and leave a fresh empty `# Unreleased` section at the top.
4. Update remaining user-facing version literals still pinned to `0.10.0` where they denote the current stable release: `docs/index.html`, `README.md`, `docs/setup.md`, `docs/env-vars.md` (`JAIPH_REPO_REF` default), and any other docs/examples found by `rg '0\\.10\\.0' docs README.md`.
5. Commit as `Release: bump version to 0.11.0 and stamp changelog`. Tag `v0.11.0` and push branch + tag (tag push triggers release workflow).

Acceptance:

* `package.json` and `package-lock.json` report `0.11.0`; `node dist/src/cli.js --version` prints `jaiph 0.11.0`.
* `docs/install` and `docs/install.ps1` default to `v0.11.0` with zero remaining `v0.10.0` pins in either installer.
* `CHANGELOG.md` has `# Unreleased` (empty) at the top and a stamped `# 0.11.0` section with both `## Summary` and `## All changes`.
* `rg '0\\.10\\.0' docs README.md` finds no stale "current release" literals (historical mentions inside older changelog sections are fine).
* `.jaiph/prepare_release.test.jh` and `integration/installer-powershell.test.ts` still pass (`npm test`).

***

