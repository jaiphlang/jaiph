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

## Feat: `trusted_envs` — declare host secrets a workflow pulls into trusted steps

**Source:** Design discussion on encoding a script's credential intent in the file instead of relying on the imperative `--env` flag. Today a script that needs `GITHUB_TOKEN` requires the operator to remember `jaiph run --env GITHUB_TOKEN …`; the need is not visible in the script, and the injected value reaches everything in the workflow env.

**Problem:** There is no declarative way for a `.jh` file to state which host environment variables it requires. `--env` (`src/cli/shared/usage.ts`, `src/cli/run/env.ts`, merged in `src/cli/commands/run.ts:104/161`) is imperative and invocation-side only. This means (a) a script's credential surface is undocumented and unauditable from the file itself, and (b) there is no per-workflow, in-file boundary describing which steps may see a given secret.

**Required behavior:**

* Add a `config` key `trusted_envs` (space-separated key list, e.g. `trusted_envs = "GITHUB_TOKEN NPM_TOKEN"`) declarable in a top-level `config` block and/or a per-`workflow` `config` block. Top-level acts as sugar applying to every workflow in the file; a per-workflow declaration scopes those keys to that workflow only.
* Declared keys are resolved from the **pristine host environment captured once at process start** — NOT from the calling workflow's `scope.env`. A sub-workflow does not inherit a caller's secrets by being called; it must declare `trusted_envs` itself to receive them. This is least-privilege and prevents secret leakage down the call chain.
* Resolved keys are injected only into **trusted `run` steps** (deterministic scripts/workflows executed via `executeRunRef`), and are **never** forwarded to `prompt` subprocesses. The `prompt` subprocess environment must remain the fail-closed allowlist (`JAIPH_*` control keys + the backend's own credential key) — `trusted_envs` values must not appear in a prompt agent's environment under any sandbox mode.
* **Only the entry file's `trusted_envs` is honored. `trusted_envs` declared in an imported module is ignored** (optionally: surfaced as a warning). Rationale: an imported module must not be able to pull arbitrary host secrets (e.g. `AWS_SECRET_ACCESS_KEY`) into its own trusted steps and exfiltrate them. This mirrors the existing lock on untrusted module metadata for `agent.command`/`agent.backend`.
* Preflight: if a declared key is absent from the host env, fail (or warn) early via the credential preflight (`src/cli/run/preflight-credentials.ts`), consistent with how missing `--env` values fail fast (`E_ENV_MISSING`).
* Interop with `--env`: `--env` continues to work as an imperative override; define and test precedence (an explicit `--env KEY=VALUE` overrides the host-snapshot value for `KEY`). `trusted_envs` is the declarative alternative for the common "forward this host key" case.
* Reserved-key rules that apply to `--env` (`RESERVED_ENV_KEYS`, `JAIPH_DOCKER_*` in `usage.ts`) apply equally to `trusted_envs`.

Acceptance:

* A workflow declaring `trusted_envs = "GITHUB_TOKEN"` receives that host value in a trusted `run` step without any `--env` flag; a test asserts the value is present in the `run`-step env.
* A test asserts the same value is **absent** from a `prompt` subprocess env (fail-closed), in both host mode and at least one Docker mode.
* A test asserts a sub-workflow that does NOT declare `trusted_envs` does not receive a key its caller declared (resolution is against the host snapshot + own declaration, not inherited scope).
* A test asserts `trusted_envs` in an imported (non-entry) module does not inject that key into any step.
* A test asserts precedence between `--env` and `trusted_envs` for the same key.
* Missing declared key triggers the preflight failure/warning path; reserved keys are rejected.
* `npm test` passes.

***

## Refactor: replace fuse-overlay/copy duality with a single snapshot sandbox #dev-ready

**Source:** FS-isolation redesign discussion (2026-07-23). Two findings drove it: (a) fuse-overlayfs is fragile and platform-dependent (elevated caps, `apparmor=unconfined`, `/dev/fuse` gating, no automatic fallback — container exits 78 and tells the human to set `JAIPH_DOCKER_NO_OVERLAY=1`), and CI already forces `JAIPH_DOCKER_NO_OVERLAY=1` on ubuntu runners (`.github/workflows/ci.yml:55-58`), so the fuse path is effectively untested; (b) overlay mode violates the intended isolation semantics — its lowerdir is the **live** host workspace mounted ro (`runtime/overlay-run.sh:3`), so host edits mid-run bleed into the container's merged view (and concurrent lowerdir modification is undefined behavior in overlayfs). Only copy mode delivers a point-in-time snapshot.

**Contract to pin (the spec, not an implementation detail):** in the default Docker mode, the container receives a **writable point-in-time snapshot** of the workspace taken at run start. Host changes during the run are invisible to the container; container workspace writes are discarded at exit; the live host workspace is **never mounted into the container at all**. Run artifacts under `/jaiph/run` persist as today. `--inplace` and `--unsafe`/host mode are unchanged.

**Required behavior:**

* **One default mechanism: host-side snapshot, bind-mounted rw.** Delete overlay mode entirely. `SandboxMode` becomes `"snapshot" | "inplace"` (rename of today's `"copy"`; `docker.ts:366`). `selectSandboxMode` reduces to: `JAIPH_INPLACE` → inplace, else snapshot. No `/dev/fuse` probing, no `JAIPH_DOCKER_NO_OVERLAY`.
* **Snapshot location:** `<run dir>/sandbox`, i.e. `.jaiph/runs/<run>/sandbox` by default. The host-side `.jaiph/runs/<run>` layout is otherwise preserved. Replaces `allocateSandboxWorkspaceDir`'s random `<runsRoot>/.sandbox-<hex>` (`docker.ts:523-529`). Uniqueness comes from the run id; crash-orphan cleanup comes for free from run-dir lifecycle. The clone-source exclusion of the runs root (`docker.ts:497`) already prevents the snapshot from being swept into its own copy — keep a test proving it.
* **No aliasing through the run mount:** `/jaiph/run` bind-mounts the host run dir, which now contains `sandbox/`. Mask it daemon-side with `--mount type=tmpfs,dst=/jaiph/run/sandbox` (zero caps, no host layout change) so the container cannot see its own snapshot source through `/jaiph/run`.
* **Snapshot mechanism, CoW-first with silent fallback:** keep the existing darwin clonefile probe (`cp -cR` → `cp -pR` fallback, `WorkspaceCloner`, `docker.ts:429-461`); on Linux/other switch to `cp --reflink=auto -pR` (block-level CoW on btrfs/XFS, transparent data-copy fallback on ext4 — no probe needed, `cp` handles it). Cross-filesystem destinations (e.g. `JAIPH_RUNS_DIR` on another volume) must still work via the fallback path.
* **Purge policy:** snapshot deleted on exit, success and failure alike (as `cleanupDocker` does today); `JAIPH_DOCKER_KEEP_SANDBOX=1|true` keeps it in place under the run dir.
* **Container posture for snapshot mode** (this is what the redesign buys): `--cap-drop ALL` with **zero** cap-adds, `no-new-privileges`, no `--device`, no `apparmor` security-opt, `--user host_uid:host_gid` on Linux — i.e. identical posture to today's copy/inplace, now the only default posture. Add/keep posture-lock tests asserting no cap-add, no device, no apparmor opt can appear in any mode.
* **Banner:** `(Docker sandbox, fusefs)` disappears; snapshot mode reports e.g. `(Docker sandbox, snapshot)` (`src/cli/run/display.ts:23-24` + its tests + `e2e/playwright/landing-page.spec.ts:39` banner regex).

**Deletion inventory — remove ALL of the following (thoroughness is part of the task; grep for `fuse`, `overlay`, `NO_OVERLAY`, `workspace-ro`, `setpriv`, `JAIPH_HOST_UID`, `E_DOCKER_OVERLAY`, `.sandbox-` afterward and account for every remaining hit):**

* `runtime/overlay-run.sh` (whole file) and its ShellCheck CI step (`.github/workflows/ci.yml:18`).
* `src/runtime/docker.ts`: `loadOverlayScript`/`writeOverlayScript`/`overlayScriptCache` (`:318-357`), `overlayMountPath` (`:663-672`), `"overlay"` from `SandboxMode` + all `mode === "overlay"` branches in `buildDockerArgs` (cap-adds `:710-723`, `/dev/fuse` + apparmor block `:727-746`, `--user 0:0` `:766-767`, workspace-ro mount `:778-781`, script mount `:794-795`, `JAIPH_HOST_UID/GID` env `:819-822`, entry-command wrapper `:828-834`), the overlay-mode `overlayScriptPath` requirement throw (`:695-696`), `overlayScriptDir` tracking/cleanup (`:858-859`, `:898-906`, `:957`, `:1019-1022`), the Linux-overlay userns `chmod 0o777` workaround (`:885-896`), `/dev/fuse` gating + `JAIPH_DOCKER_NO_OVERLAY` in `selectSandboxMode` (`:388-396`) and its docstring (`:374-386`), overlay references in the `DockerSpawnOptions`/`buildDockerArgs` doc comments (`:570`, `:678-691`).
* Embedded asset: `OVERLAY_RUN_SH` entry in `tools/embed-assets.js:19`, `OVERLAY_RUN_SH_BASE64` in `src/runtime/embedded-assets.ts` (regenerate via `npm run embed-assets`), its round-trip test in `src/runtime/embedded-assets.test.ts:27-29`.
* Build/packaging: the `cpSync('runtime/overlay-run.sh', …)` step in the `build` script and the `"runtime/overlay-run.sh"` files entry (`package.json:11`).
* Image: `fuse-overlayfs` + `fuse3` packages, the `COPY runtime/overlay-run.sh` layer, and overlay/root-ownership comments in `runtime/Dockerfile` (`:6`, `:8`, `:16`, `:56-57`, `:197`, `:238`).
* CI: `JAIPH_DOCKER_NO_OVERLAY` matrix env (`.github/workflows/ci.yml:55-58`, `:97`).
* Env/error surface: `JAIPH_DOCKER_NO_OVERLAY` everywhere (including `e2e/lib/common.sh:426` filter), `JAIPH_HOST_UID`/`JAIPH_HOST_GID`, `E_DOCKER_OVERLAY` (exit 78) — and their rows in `docs/env-vars.md` (`:52`, `:99`, `:139`); `JAIPH_DOCKER_KEEP_SANDBOX` doc row updated for the new path (`docs/env-vars.md:50`).
* Tests: every overlay-mode test in `src/runtime/docker.test.ts` (overlay args/caps/apparmor/user tests `:280-320`, `:915-1050`, `overlayMountPath` `:567-579`, `writeOverlayScript`/`loadOverlayScript` `:583-670`, chmod-workaround `:685-687`, overlay posture-lock block `:1399-1500` — replace with snapshot-mode posture locks, docs-token tests `:1477-1498` — retarget to rewritten docs), the `TEST_OVERLAY` fixture plumbing (`:47-52` and every `buildDockerArgs(…, TEST_OVERLAY)` call), overlay banner tests in `src/cli/run/display.test.ts`, the overlay-unavailable fixture line in `src/cli/run/stderr-handler.test.ts:78-85`, `.sandbox-*` path assertions in `docker.test.ts` (`:1542-1546`, `:1620-1655`) and `e2e/tests/74b_docker_signal_cleanup.sh` (`:11`, `:104-111`) — retarget to the new run-dir location.
* Help/docs text: `src/cli/commands/mcp.ts:33-35` + `:158`; rewrite the affected sections of `docs/sandboxing.md` (three-modes section, `#overlay-capability-posture` section, toolchain table `:266`), `docs/sandbox-run.md` (`:27-32`, `:86`), `docs/mcp.md` (`:107`, `:157`, `:163`), `docs/cli.md:346`, `docs/architecture.md:97-98`, `docs/first-agent-run.md` (`:46-47`, `:100-108`, `:123`), `docs/artifacts.md:112` link text, `docs/contributing.md` (`:81`, `:200` ShellCheck row). No migration notes — hard rewrite; describe only the new model.

Acceptance:

* **Snapshot-resistance e2e test (the contract):** start a default-mode Docker run that reads a workspace file after a delay; modify that file on the host mid-run; assert the container saw the snapshot-time content. Same test (or sibling) asserts a container workspace write does not appear on the host, and that the host workspace path is absent from the container's mounts.
* Unit test: snapshot lands at `<run dir>/sandbox`, is deleted after the run (success AND failure), and survives with `JAIPH_DOCKER_KEEP_SANDBOX=1`.
* Unit test: container args include the tmpfs mask at `/jaiph/run/sandbox`; e2e or unit proof that the snapshot is not readable through `/jaiph/run`.
* Posture-lock tests: no `--cap-add`, no `--device`, no `apparmor` security-opt in any remaining mode; `--user` is host uid:gid on Linux in both modes.
* Linux clone path uses `--reflink=auto`; a unit test covers the flag choice per platform (spawn injectable, as in existing `WorkspaceCloner` tests).
* A repo-wide grep for `fuse`, `overlay` (case-insensitive), `NO_OVERLAY`, `workspace-ro`, `setpriv`, `JAIPH_HOST_UID`, `E_DOCKER_OVERLAY` under `src/`, `runtime/`, `tools/`, `e2e/`, `docs/` (excluding `docs/vendor/`), `.github/`, `package.json` returns no sandbox-related hits (unrelated hits like `-fuse-ld` in vendored files or "refuses" prose are fine — justify each survivor in the PR description).
* `npm test` and `npm run test:e2e` pass; e2e passes on a host where fuse-overlayfs was previously selected (Linux with `/dev/fuse`) without any `JAIPH_DOCKER_NO_OVERLAY`-style escape hatch remaining.

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
