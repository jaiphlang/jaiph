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

## `prepare_release.jh`: release-prep workflow with version bump, displayed-version check, and registry build #dev-ready

**Context.** The CLI version is declared twice with nothing keeping them in sync: `package.json` `"version": "0.9.4"` and the **hardcoded** display string in `src/cli/index.ts:19` (`process.stdout.write("jaiph 0.9.4\n")`). The CLI ships in two build forms — `tsc` → `dist/` and a `bun build --compile` standalone binary (`npm run build:standalone`) — so the version must be resolved **at build time** (static JSON import or generated module), not by reading `package.json` from disk at runtime, which the standalone binary cannot do. Releases are cut by tagging `v<version>` and pushing — the `v*` tag triggers the docker-publish job in `.github/workflows/ci.yml`, and `jaiph use <version>` installs tag `v<version>`; npm publish is intentionally outside this repo (see `docs/contributing.md`, "Version tags and npm"). The repo dogfoods jaiph via `.jaiph/*.jh` workflows (`engineer.jh`, `qa.jh`, …); workflow args are forwarded with `jaiph run <file.jh> -- args...` to `workflow default`. `npm run registry:build` (added by the "Registry build command" task earlier in this queue — implement that first if missing) regenerates `docs/registry` from the upstream `jaiphlang/registry` index and fails non-zero without touching the file on error.

**Change.** Add `.jaiph/prepare_release.jh` with `workflow default(version)`, run as `jaiph run .jaiph/prepare_release.jh -- 0.9.5` (or with no arg). Steps, in order; any failure aborts the workflow non-zero:
1. **Resolve version.** Empty arg → next patch version computed from `package.json` (e.g. `0.9.4` → `0.9.5`). Non-empty arg must match `X.Y.Z` (digits only); anything else fails with the offending value.
2. **Preflight.** Fail if the git tree is dirty (the workflow's edits must be the only diff a reviewer sees) or if tag `v<version>` already exists.
3. **Single-source the version (one-time refactor, part of this task).** Replace the hardcoded string in `src/cli/index.ts:19` with the version from `package.json`, resolved at build time (e.g. a static `import pkg from "../../package.json"` with `resolveJsonModule`, or a tiny generated `src/version.ts` written by the build script — whichever works for **both** the `tsc` and the `bun build --compile` outputs). After this, `package.json` is the only place the version exists and the workflow never edits `src/`.
4. **Apply the version change.** `npm version <version> --no-git-tag-version` (updates `package.json` + `package-lock.json`), plus update the hardcoded default release ref in `docs/install` (the `v<current>` fallback used when no ref argument and no `JAIPH_REPO_REF` is given — locate it by grepping the script for the old version; its exact shape depends on the current installer). It cannot be single-sourced since the install script must work standalone via `curl | bash`.
5. **Displayed-version check.** `npm run build`, then run the built CLI with `--version`; output must be exactly `jaiph <version>`. This is an end-to-end check on the built artifact (catches a stale build or a broken version import/codegen, not just string drift). On mismatch, fail showing both the expected and actual string.
6. **Build the registry.** Run `npm run registry:build` so the release ships a current `docs/registry`.
7. **Summary.** Log the changed files and the remaining manual steps: review the diff, commit, `git tag v<version>`, push branch + tag (tag push triggers the docker-publish CI job and the binary release workflow), then smoke-check with `jaiph use <version>`. The workflow itself must create **no commits and no tags**.

**Acceptance criteria.**
- No version literal remains in `src/` (`grep -rn "0\.9\." src/` finds no hardcoded CLI version); a unit test asserts the `--version` output equals `jaiph ` + the `version` field of `package.json`, and the standalone binary build (`npm run build:standalone`) reports the same.
- A workflow test (e.g. `.jaiph/prepare_release.test.jh`, discovered by `jaiph test`) covers: next-patch default from `package.json`; explicit version arg; rejection of a non-`X.Y.Z` arg; displayed-version mismatch fails with both values in the output; dirty-tree preflight failure.
- Run end-to-end on a clean checkout with an explicit `X.Y.Z`: afterwards `package.json`, `package-lock.json`, and the built `jaiph --version` all report `X.Y.Z`, and `grep -c "v<old version>" docs/install` returns 0.
- After a run, `git log` and `git tag` are unchanged (no commits or tags created by the workflow).
- `docs/contributing.md` "Version tags and npm" section gains a pointer to `prepare_release.jh` as the supported release-prep path.
