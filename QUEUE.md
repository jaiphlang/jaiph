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

## Registry build command: regenerate docs/registry from jaiphlang/registry #dev-ready

**Context.** `docs/` is published via GitHub Pages at `jaiph.org` (`docs/CNAME`); extensionless static files there are served as-is (see `docs/install`, `docs/init`, `docs/run`). The **source of truth** for the package index is `registry.json` in the separate repo `https://github.com/jaiphlang/registry` (created manually by the maintainer; package publishing PRs go there, not here). `jaiph install` resolves bare lib names against a JSON index `{ "libs": { "<name>": { "url": "<git clone url>", "description": "<one line>" } } }` loaded from `https://jaiph.org/registry` by default (overridable via `JAIPH_REGISTRY`), via an exported `loadRegistryIndex(source)` in `src/cli/commands/install.ts` that accepts URLs and file paths. So `docs/registry` in this repo must be a generated copy of the upstream index — never hand-edited. Build conventions are in `package.json` scripts (tsc → `dist/`).

**Change.**
1. Add a build script (e.g. `scripts/build-registry.mjs`) that: fetches the upstream index from `https://raw.githubusercontent.com/jaiphlang/registry/main/registry.json` (source overridable via env var or argv for tests), validates it through the built `loadRegistryIndex` (import from `dist/` — the script requires `npm run build` first), and writes it verbatim to `docs/registry` (extensionless, no Jekyll front matter). On invalid or unreachable upstream it must exit non-zero **without touching** `docs/registry`.
2. Add npm script `registry:build` (build + run the script). This is a **regular command callable anytime** — after merging a registry PR, run it, commit the changed `docs/registry`, push; Pages redeploys automatically. It is also invoked by the release-prep workflow (separate queue task).
3. Seed `docs/registry` with the initial index content (entry `jaiphlang` → `https://github.com/jaiphlang/jaiphlang.git`, description "Jaiph standard library: artifacts, git, queue") so jaiph.org serves a valid index before the first build run.
4. Extend `docs/libraries.md` with: the layout of a library repo (top-level `.jh` modules, `export` visibility, companion scripts like `queue.py`); versioning via git tags; **publishing = push a public git repo, tag a release, open a PR adding an entry to `registry.json` in `jaiphlang/registry`** (live on jaiph.org once a maintainer runs `npm run registry:build` and pushes the regenerated file — at the latest with the next release); installing by name (`jaiph install jaiphlang@v0.1.0`); lockfile semantics including commit pinning; the `JAIPH_REGISTRY` override.
5. Update the `jaiph install` section of `docs/cli.md` (~line 346) with the bare-name form and an example, and add `JAIPH_REGISTRY` to the environment variable list (~line 476).

**Acceptance criteria.**
- A unit test loads the real shipped `docs/registry` through `loadRegistryIndex` (schema drift between the shipped file and the CLI fails the test); the file parses as JSON and contains no Jekyll front matter.
- Build script test: pointed at a local valid index file it produces a byte-identical `docs/registry`; pointed at invalid JSON or a missing source it exits non-zero and leaves the previous `docs/registry` untouched.
- `docs/libraries.md` contains the publishing flow (PR to `jaiphlang/registry`, then `npm run registry:build`) and documents `JAIPH_REGISTRY`; `docs/cli.md` shows the bare-name form and lists `JAIPH_REGISTRY`.
- The docs-parity workflow (`.jaiph/docs_parity.jh`), if run, raises no contradiction between the docs and `src/cli/commands/install.ts`.

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
