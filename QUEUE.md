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

## Add a Zed language extension under `plugins/zed` #dev-ready

Zed has no Jaiph support. Zed language extensions require Tree-sitter (not TextMate), so VS Code grammars cannot be reused as-is. An empty `plugins/zed/` placeholder exists; ship a real extension there.

Scope:

- Create a Zed extension at `plugins/zed/` with `extension.toml` and `languages/jaiph/` (`.jh` / `*.test.jh` suffixes, comment/bracket config, highlights queries).
- Provide a Tree-sitter grammar for Jaiph (new tree under this repo, e.g. `grammars/tree-sitter-jaiph/`, unless an existing grammar already exists — do not invent a second grammar home). Pin it from `extension.toml` by repository + revision (or `file://` for local dev).
- Cover the same current-language construct set as the VS Code task (keywords, blocks, comments, strings, embedded script regions as far as Tree-sitter queries reasonably allow).
- Document local install (Zed "Install Dev Extension" pointing at `plugins/zed`) and the marketplace path (`path = "plugins/zed"` when publishing to `zed-industries/extensions`).

Acceptance:

- A Zed fixture `.jh` file for current constructs receives highlighting tokens for keywords, comments, and strings; a test or query-check fails if those queries regress.
- `extension.toml` builds/loads as a Zed extension from `plugins/zed/` without requiring files outside that tree except the pinned grammar.
- Docs state how to install from this monorepo path and how the grammar is version-pinned.

## Add `actions/setup-jaiph` for CI installs #dev-ready

Other repositories need a one-step way to install a pinned Jaiph CLI in GitHub Actions. A placeholder exists at `actions/setup-jaiph/`; ship a reusable composite (or JS) action there.

Scope:

- Implement `actions/setup-jaiph/action.yml` that installs Jaiph onto `PATH` for `runner.os` / arch used by GitHub-hosted runners.
- Inputs at minimum: `version` (semver / `nightly` / release tag). Prefer the same release/binary channel as `docs/setup.md` (standalone release binaries + checksums); do not require Node on the consumer workflow unless npm is an explicit documented fallback.
- Add the install directory to `GITHUB_PATH`. Fail closed on checksum (and signature when `minisign` is available) failure — match installer fail-closed policy.
- Document usage: `- uses: jaiphlang/jaiph/actions/setup-jaiph@<tag>` with a pinned version input. Optionally exercise the action from this repo's CI on a path filter so it does not bitrot.

Acceptance:

- A workflow using the action can run `jaiph --version` and get the requested version (or nightly) on linux and darwin runners covered by release artifacts.
- Wrong checksum / missing artifact fails the step; success leaves `jaiph` on `PATH` for subsequent steps.
- README under `actions/setup-jaiph/` shows a minimal workflow snippet that matches the implemented inputs.
