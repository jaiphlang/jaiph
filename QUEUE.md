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

## Remove dead `formatDiagnosticLine` indirection in the stderr parser #dev-ready

**Context.** `src/cli/run/stderr-handler.ts` threads a `formatDiagnosticLine: (line: string) => string` parameter through `handleLine` (line 49) and defines it as the identity function `(ln) => ln` (line 86) at the only call-site builder (`createStderrParser`, line 90). It never formats anything — pure dead indirection.

**Change.** Delete the parameter from `handleLine` and the identity function from `createStderrParser`; use `line` directly in the `emitter.emit("stderr_line", …)` call (line 78). Update all `handleLine` call sites and any tests that pass the parameter.

**Acceptance criteria.**
- `grep -rn "formatDiagnosticLine" src/` returns nothing.
- `npm test` passes; stderr passthrough behavior in run output is unchanged (existing integration tests cover this).

## Document the Docker env-var allowlist in sandboxing docs #dev-ready

**Context.** `isEnvAllowed()` (`src/runtime/docker.ts:479`) forwards only environment variables matching `ENV_ALLOW_PREFIXES` (see the constant near that function — e.g. `JAIPH_`, agent/LLM-related prefixes) into the container, excluding `JAIPH_DOCKER_*`. `docs/sandboxing.md` does not mention this filtering, so users cannot tell why their custom env vars vanish inside sandboxed runs.

**Change.** Add a "Environment forwarding" section to `docs/sandboxing.md`: list the exact allow prefixes and the `JAIPH_DOCKER_*` exclusion (read them from the constants in `src/runtime/docker.ts` — do not guess), state that all other host variables are **not** forwarded, and show the workaround (export inside a `script` body, or bake values into the image). Cross-link from `docs/configuration.md` ("Inspecting effective config at runtime") and `docs/cli.md` (Docker env var section).

**Acceptance criteria.**
- `docs/sandboxing.md` contains the new section with the prefix list matching the source constants verbatim (reviewer check: diff the doc list against `ENV_ALLOW_PREFIXES` / `ENV_ALLOW_EXCLUDE_PREFIX` in `src/runtime/docker.ts`).
- The docs-parity workflow (`.jaiph/docs_parity.jh`), if run, raises no contradiction between the section and the implementation.
- Cross-links added in the two referenced docs.

## Make the standalone binary fully self-contained (self-spawn + embedded assets) #dev-ready

**Context.** `npm run build:standalone` (`bun build --compile ./src/cli.ts --outfile ./dist/jaiph`) produces a single-file executable, but it is shipped nowhere and `jaiph run` is broken in it for two reasons:
1. **Self-spawn.** `src/runtime/kernel/workflow-launch.ts:20-23` launches the workflow leader as `spawn(process.execPath, [join(__dirname, "node-workflow-runner.js"), …])`. Under node, `execPath` is the node binary and this executes the runner script. In a bun-compiled executable, `process.execPath` is the **jaiph binary itself**, which always runs its embedded entrypoint — the runner path is interpreted as CLI argv and the workflow leader never starts.
2. **Disk-relative assets.** The CLI reads files relative to its installation at runtime: `runtime/overlay-run.sh` (`src/runtime/docker.ts`, used by Docker sandboxing) and `docs/jaiph-skill.md` (resolved by `jaiph init`, see `src/cli/commands/init.ts` and the install-relative lookup described in `docs/cli.md` ~line 344). A bare binary has no such siblings.

**Change.**
1. Add an internal argv dispatch: a reserved first argument (e.g. `__workflow-runner`) handled at the top of `main` (`src/cli/index.ts`) that runs the workflow-runner entrypoint with the remaining args. `workflow-launch.ts` spawns `process.execPath` with that argv form in a way that works identically for the tsc build (node + `cli.js __workflow-runner …`) and the compiled binary (`jaiph __workflow-runner …`). The reserved argument must be excluded from help/usage and rejected paths.
2. Embed the assets: make `overlay-run.sh` and `jaiph-skill.md` available **inside** the executable — e.g. a build step that generates TS modules from the files (works for both tsc and bun builds), or bun file embedding with a disk fallback for the node build. Keep behavior identical for the tsc build. (Compose with the earlier queue task "Lazy-load the Docker overlay script": the `E_CLI_SETUP` error path remains for the node build when the file is genuinely missing; the binary never hits it.)
3. The binary must work from any directory with no repo checkout and no node/npm/git on PATH (git is only needed at runtime by workflows that call git, not by the CLI itself).

**Acceptance criteria.**
- A CI-runnable check (script or e2e case) builds `dist/jaiph` and, in a clean temp dir with `PATH` stripped of node/npm, runs at minimum: `jaiph --version`, `jaiph init`, `jaiph compile` of a sample, and `jaiph run` of a deterministic sample workflow to completion.
- `jaiph init` in that environment writes `SKILL.md` from the embedded copy.
- The existing e2e suite passes unchanged for the tsc build (`npm run test:e2e`).
- Unit test for the argv dispatch: `__workflow-runner` routes to the runner in both build forms (assert on the tsc build; binary covered by the e2e check above) and does not appear in `--help` output.

## Release workflow: build and publish per-platform binaries on `v*` tags #dev-ready

**Context.** CI lives in `.github/workflows/ci.yml` (push CI; its docker-publish job already triggers on `v*` tags) and `nightly-engineer.yml`. There is no release pipeline: nothing builds or publishes the standalone binary (`npm run build:standalone`, bun-compiled). The installer rewrite (separate queue task) will download release assets named by a fixed contract.

**Change.**
1. Add `.github/workflows/release.yml` triggered by `v*` tag pushes (plus `workflow_dispatch` for re-runs). Using `oven-sh/setup-bun`, cross-compile the standalone binary for: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64` (`bun build --compile --target=…`). **Asset naming contract:** `jaiph-darwin-arm64`, `jaiph-darwin-x64`, `jaiph-linux-x64`, `jaiph-linux-arm64`, plus a `SHA256SUMS` file covering all four.
2. Create (or update) the GitHub Release for the tag with `gh release create/upload`, attaching all assets. The job should require the main CI checks to have passed for the same ref before publishing (job-level `needs` if merged into `ci.yml`, or an explicit gate step otherwise).
3. Nightly channel: on push to the `nightly` branch, build the same matrix and upload to a **rolling prerelease** tagged `nightly` (`gh release upload nightly --clobber`), so `jaiph use nightly` keeps working under the binary installer.
4. Sanity gate inside the workflow: before upload, run the produced linux-x64 binary on the runner (`./jaiph-linux-x64 --version`) and assert the output version matches the tag.

**Acceptance criteria.**
- Workflow file exists with the tag + nightly + dispatch triggers, the four targets, checksum generation, the version sanity gate, and release upload steps (reviewer check; full verification happens on the first real tag).
- The asset naming contract above is written down in `docs/contributing.md` (release section) — the installer task depends on it verbatim.
- A `workflow_dispatch` dry run on a test tag (maintainer-executed) produces a release with 5 assets and a correct `SHA256SUMS`.

## Binary installer: rewrite `docs/install` to download release assets; update `install-from-local.sh` #dev-ready

**Context.** `docs/install` (served at `https://jaiph.org/install`, run via `curl | bash`) currently clones the repo at a tag, runs `npm install` + `npm run build` on the user's machine, and installs a node shim — requiring git, node 20, and npm on every user machine. Release CI (separate queue task — implement it first) publishes per-platform standalone binaries on `v*` tags and a rolling `nightly` prerelease under the asset contract `jaiph-{darwin|linux}-{arm64|x64}` + `SHA256SUMS`. The binary embeds `jaiph-skill.md` and `overlay-run.sh`, so the binary is the entire installation. `docs/install-from-local.sh` and the `JAIPH_FROM_LOCAL` branch of `docs/install` install from a local checkout (used by developers and the e2e install tests); `jaiph use <version|nightly>` re-runs the install command with `JAIPH_REPO_REF` set.

**Change.**
1. Rewrite `docs/install`: detect platform (`uname -s` / `uname -m`, mapping `x86_64`→`x64`, `aarch64`→`arm64`); resolve the ref (first arg or `JAIPH_REPO_REF`, default the current release tag; `nightly` → the rolling prerelease); download `https://github.com/jaiphlang/jaiph/releases/download/<ref>/jaiph-<os>-<arch>` and `SHA256SUMS`; **verify the checksum** (fail hard on mismatch); install to `${JAIPH_BIN_DIR:-$HOME/.local/bin}/jaiph` with mode 755. Prerequisites shrink to `curl` + `shasum`/`sha256sum`. Unsupported platform → non-zero exit naming the detected platform and pointing at the from-source instructions in `docs/contributing.md`.
2. Keep the local-install path working without releases: when `JAIPH_REPO_URL`/arg is a local directory (the `JAIPH_FROM_LOCAL` branch), build the binary from that source (`npm install` + `npm run build:standalone`, requires bun) and install `dist/jaiph`. Update `docs/install-from-local.sh` accordingly. This is the path the e2e install tests exercise — they must not depend on GitHub Releases. **Parity requirement:** both paths must produce an identical installation — a single self-contained executable at `${JAIPH_BIN_DIR:-$HOME/.local/bin}/jaiph`, no node shim, no `LIB_DIR` tree; only the origin of the binary differs (downloaded vs. locally compiled).
3. Remove the now-dead `LIB_DIR` runtime tree and node shim logic; the PATH-hint UX at the end stays.
4. Update docs: `docs/contributing.md` (prerequisites for users vs. developers — bun becomes a dev prerequisite; from-source install instructions preserved here), `docs/getting-started.md` / `docs/setup.md` install snippets, and the `jaiph use` section of `docs/cli.md` if its wording references building from source.

**Acceptance criteria.**
- e2e install tests pass using the local-build path on macOS and in the WSL/Linux CI job (`npm run test:e2e`).
- Installer unit/e2e checks: checksum mismatch → non-zero exit, nothing installed; unsupported platform string → non-zero exit with the documented message; successful install → `jaiph --version` works with node/npm absent from `PATH`.
- Parity check after a local install (`install-from-local.sh`): the install dir contains a single executable `jaiph` (no shim script, no `LIB_DIR`/runtime tree), and `jaiph --version` + `jaiph run` of a deterministic sample work with node/npm absent from `PATH` — same assertions as the release-asset path.
- `bash -n docs/install` and `shellcheck` (if available in CI) pass.
- `grep -n "npm run build" docs/install` matches only the local-source branch.

## Registry name resolution: `jaiph install <name>[@version]` #dev-ready

**Context.** `jaiph install` (`src/cli/commands/install.ts`) only accepts git clone URLs. The lib directory name is derived from the URL's last path segment (`deriveLibName`, line 51), and the import resolver (`src/transpile/resolve.ts:25-52`) maps `import "jaiphlang/artifacts"` to `.jaiph/libs/jaiphlang/artifacts.jh` — so a lib's **directory name is its import prefix**, which today silently requires the git repo to be named exactly like the import prefix. There is no name → URL indirection and no way to write `jaiph install jaiphlang`.

**Change.**
1. Define the registry index format — a single JSON document:
   ```json
   { "libs": { "<name>": { "url": "<git clone url>", "description": "<one line>" } } }
   ```
   Names must match `/^[A-Za-z0-9_-]+$/` (single path segment — the name becomes the `.jaiph/libs/<name>` directory and the import prefix).
2. In `runInstall`, treat an argument matching `/^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/` (no `/`, no `:`) as a registry name with optional `@version`. Everything else takes the existing URL path unchanged.
3. For registry names, load the index from the `JAIPH_REGISTRY` env var if set, else from a new constant `DEFAULT_REGISTRY_URL = "https://jaiph.org/registry"`. If the source has no `://` prefix or uses `file://`, read it from disk (enables unit tests and air-gapped use); otherwise fetch it with global `fetch`. Load the index at most once per `runInstall` call, and only when at least one bare-name arg is present. Export the loading/validation function (e.g. `loadRegistryIndex(source)`) so other tooling (the registry sync script, tests) reuses the exact same code path.
4. The **registry key** (not `deriveLibName(url)`) is the lib name: it names the `.jaiph/libs/<name>` directory and the lock entry. The lock entry stores the resolved clone URL exactly as today, so restore-from-lock (`jaiph install` with no args) never contacts the registry.
5. Actionable errors, all exiting non-zero: unknown name → `lib "<name>" not found in registry <registry-source>`; fetch/read/parse failure → message containing the registry source and the underlying cause.
6. Update `INSTALL_USAGE` to show the name form and `JAIPH_REGISTRY`.

**Acceptance criteria.**
- Unit test: installing `mylib` via a path-based `JAIPH_REGISTRY` whose entry points at a repo whose last URL segment is *different* from `mylib` installs into `.jaiph/libs/mylib/` and writes lock entry name `mylib`.
- Unit test: `mylib@v1.2` passes `v1.2` as the version to the clone runner and records it in the lock entry.
- Unit tests assert the unknown-name and unreadable/invalid-registry error message shapes.
- URL-based installs behave exactly as before — existing install tests pass unmodified.
- Unit test: restore-from-lock succeeds with `JAIPH_REGISTRY` pointing at a nonexistent path (proves restore never reads the registry).

## Lockfile commit pinning and clone hygiene in `jaiph install` #dev-ready

**Context.** `gitCloneRunner` (`src/cli/commands/install.ts:95`) shallow-clones libs into `.jaiph/libs/<name>/` and leaves the `.git` directory behind, so installed libs appear as nested git repos inside consumer projects. The lockfile (`.jaiph/libs.lock`) records only `{name, url, version}` — and `version` is a git ref that can be moved, so "restore from lockfile" is not actually reproducible. Nothing validates that a cloned repo is a jaiph library at all.

**Change.**
1. After a successful clone, run `git -C <libDir> rev-parse HEAD` and store the result as `commit` in the lock entry, then delete `<libDir>/.git` recursively. Installed libs are plain files; the lockfile is the source of truth for restore.
2. On restore-from-lock, when an entry has `commit`: after cloning at the recorded `version`, compare `rev-parse HEAD` against it. On mismatch, remove the lib dir and fail with a message naming the lib, both SHAs, and the remedy (the ref may have moved; re-run `jaiph install <name-or-url>@<version>` explicitly to accept the new commit). Entries without `commit` (older lockfiles) restore without the check.
3. Validate that the cloned tree contains at least one `*.jh` file (recursively). If not, remove the dir and fail with `lib "<name>" contains no .jh modules — not a jaiph library?`; do not write a lock entry for it.

**Acceptance criteria.**
- Tests use local fixture repos (`git init` + commit in a temp dir; `git clone` accepts local paths) — no network.
- After install: no `.git` directory inside `.jaiph/libs/<name>/`; lock entry contains a 40-char `commit`.
- Tag-moved scenario (retag the fixture repo after locking, then restore) fails with both SHAs in the message and a non-zero exit, and the lib dir is removed.
- A fixture repo with no `.jh` files fails install with the message above, leaves no `.jaiph/libs/<name>/` dir, and adds no lock entry.
- Lock entries without `commit` still restore successfully (backward-compat test).

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
