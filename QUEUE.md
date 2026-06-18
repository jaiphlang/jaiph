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

## Add a `inplace` Docker sandbox mode (live host edits, machine still isolated) #dev-ready

### Context

Docker sandboxing lives in `src/runtime/docker.ts`. Today there are exactly two sandbox modes (`SandboxMode = "overlay" | "copy"`, line ~327). Both **protect the host workspace from the run**: `overlay` mounts the workspace `:ro` and uses fuse-overlayfs so edits die with the container; `copy` clones the workspace and mounts the disposable clone `:rw`. In both, the host repo is untouched and edits are never persisted.

This task adds a **third mode**, `inplace`, for the iterate-on-real-files dev loop: the host workspace is bind-mounted `:rw` directly so **the run's edits land live on the host**, while the container boundary still prevents access to the rest of the machine (only the workspace + runs dir are mounted; caps dropped; `no-new-privileges`; env filtered by `remapDockerEnv`/`isEnvAllowed`).

Be explicit about what this mode does and does NOT change:
- It does **not** add machine-level protection — that is already inherent to every mode (mount set + `--cap-drop ALL` + `no-new-privileges` + env allowlist). It only **removes workspace isolation** in exchange for persistent edits.
- It is a different safety posture ("trusted workspace, untrusted machine"), so it must be **explicit opt-in**, never a default of `selectSandboxMode`.

### Scope / required changes

1. **Type + selection** (`src/runtime/docker.ts`)
   - Extend `SandboxMode` to `"overlay" | "copy" | "inplace"`.
   - `selectSandboxMode(env)` returns `"inplace"` **only** when explicitly requested via the env var `JAIPH_INPLACE=1` (or `"true"`). This opt-in takes precedence over the existing `/dev/fuse` and `JAIPH_DOCKER_NO_OVERLAY` logic. Without the env var, behavior is unchanged.
   - **Enabling flag.** `JAIPH_INPLACE` is the single enabling switch — short and user-facing, a sibling of `JAIPH_UNSAFE` (not a low-level `JAIPH_DOCKER_*` knob). It is a *different axis* from `JAIPH_UNSAFE`: `JAIPH_UNSAFE=true` turns the sandbox **off** entirely (`resolveDockerConfig` → `enabled=false`, run on host), whereas `JAIPH_INPLACE` keeps the sandbox **on** (machine isolated) and only persists workspace edits. Do NOT change `resolveDockerConfig`'s enabled logic.

2. **`buildDockerArgs` / `spawnDockerProcess`**
   - For `inplace`: bind-mount `resolve(opts.workspaceRoot)` (NOT a clone, NOT `:ro`) at `${CONTAINER_WORKSPACE}:rw` via `validateMountHostPath`. Reuse the non-overlay command path (no `overlay-run.sh`, no `--device /dev/fuse`, no `SYS_ADMIN/SETUID/SETGID/CHOWN/DAC_READ_SEARCH` caps, no `apparmor=unconfined`).
   - On Linux, run as the host UID/GID (`--user ${hostUid}:${hostGid}`, same as `copy` mode) so files created by the run are owned by the user, not root. Reuse `_uidDetect.getHostUidGid()` and its existing `E_DOCKER_UID` failure.
   - macOS note (no action, just don't be surprised): the `:rw` bind-mount goes through Docker Desktop's virtiofs file-sharing layer, so write throughput is slower than the APFS `cp -cR` clone `copy` mode uses. Acceptable for the dev-loop use case.
   - In `spawnDockerProcess`, the `inplace` branch must **not** call `allocateSandboxWorkspaceDir`/`cloneWorkspaceForSandbox` and must not require `sandboxWorkspaceDir`. The `.jaiph/runs` mount (`CONTAINER_RUN_DIR:rw`) is still mounted separately and the nested-under-workspace case must still work.
   - `buildDockerArgs` validation: `inplace` requires neither `overlayScriptPath` nor `sandboxWorkspaceDir`.

3. **Destructive-edit safeguard: warn + confirm (defining feature, not optional)**
   - Because a crashed/killed run now leaves the real workspace half-mutated with no rollback, `inplace` must, before launching the container, **warn** the user that edits will be written live to the host workspace and then **interactively ask yes/no** to proceed.
   - **Message must be friendly and developer-oriented** — plain language, name the actual directory, and explain the consequence and the way out concretely. Adapt to git state. If `git` is unavailable on PATH or the workspace is not a git repo (e.g. `.jaiph`-marked only), treat it as the "no recovery point / irreversible" case — never crash on a failed git invocation. Illustrative copy (wording can be refined, the substance is required):
     - **Clean git tree:**
       > ⚠️  jaiph in-place mode: the workflow will edit files directly in `<workspace>` on your machine.
       > Your git tree is clean, so anything this run changes can be undone with `git restore .` (or `git reset --hard`).
       > Everything outside this directory stays sandboxed — the run can't touch the rest of your machine.
       > Continue? [y/N]
     - **Dirty git tree:**
       > ⚠️  jaiph in-place mode: the workflow will edit files directly in `<workspace>` on your machine.
       > You have uncommitted changes — the run's edits will be mixed in with them and can't be cleanly undone. Consider committing or stashing first.
       > Everything outside this directory stays sandboxed — the run can't touch the rest of your machine.
       > Continue? [y/N]
     - **No git repo:**
       > ⚠️  jaiph in-place mode: the workflow will edit files directly in `<workspace>` on your machine.
       > No git repository found here, so there's no safety net — these changes are irreversible. Consider `git init` and committing first.
       > Everything outside this directory stays sandboxed — the run can't touch the rest of your machine.
       > Continue? [y/N]
   - The prompt is **skippable with a flag**: `JAIPH_INPLACE_YES=1` (or `"true"`) auto-confirms without prompting. This is the automation/CI path.
   - **Non-TTY behavior:** when stdin is not a TTY (the `isTTY` value already threaded through `run.ts`), there is no way to prompt. In that case, require `JAIPH_INPLACE_YES=1`; if it is absent, abort with a clear `E_DOCKER_INPLACE_NO_CONFIRM` error instructing the user to set the flag. Never silently proceed unconfirmed.
   - A "no" answer aborts the run cleanly (non-zero exit, no container launched), not a crash.
   - There is no existing interactive-confirm helper in the codebase — implement a minimal readline-based yes/no prompt (default to "no" on empty input / EOF).

4. **Plumbing / surfacing**
   - Ensure `src/cli/commands/run.ts` propagates the selected mode (the run banner already shows the mode via `selectSandboxMode`; `inplace` must display distinctly).
   - **Env leak:** `JAIPH_INPLACE` / `JAIPH_INPLACE_YES` are `JAIPH_`-prefixed, so they currently PASS `isEnvAllowed` (only `JAIPH_DOCKER_*` is excluded via `ENV_ALLOW_EXCLUDE_PREFIX`) and would be forwarded into the container. Explicitly exclude them so they do not leak inside (and so a nested run can't re-trigger the mode).

### Out of scope

- Changing default mode selection on any platform.
- `--network none` defaults (network behavior stays as-is; may be a follow-up).
- Concurrency locking for parallel runs on the same workspace (note it in code comments as a known sharp edge, but do not implement).

### Acceptance criteria (each verified by a test that fails when violated)

- `selectSandboxMode` returns `"inplace"` iff `JAIPH_INPLACE` is `1`/`true`; with it set, that wins over both `JAIPH_DOCKER_NO_OVERLAY` and `/dev/fuse` presence. Unset → existing overlay/copy behavior is byte-for-byte unchanged (regression test).
- `buildDockerArgs` in `inplace` mode produces args that: (a) bind-mount the **real** `workspaceRoot` at `${CONTAINER_WORKSPACE}:rw`; (b) contain **no** `:ro` workspace mount, **no** `--device /dev/fuse`, **no** `overlay-run.sh`, and **none** of the overlay-only `--cap-add` flags; (c) still include `--cap-drop ALL`, `--security-opt no-new-privileges`, and the `${CONTAINER_RUN_DIR}:rw` runs mount; (d) on Linux include `--user ${hostUid}:${hostGid}`.
- `spawnDockerProcess` in `inplace` mode does not invoke `cloneWorkspaceForSandbox`/`allocateSandboxWorkspaceDir` and succeeds without `sandboxWorkspaceDir` (assert via spy/mock that the clone path is never taken).
- A test proves a write performed inside `inplace` is visible at the host path while `copy`/`overlay` leave the host path unchanged (filesystem-level assertion; may stub docker exec to write through the same bind path the args specify).
- Confirmation gate (all branches covered by tests):
  - TTY + user answers "no" → run aborts, no container launched, non-zero exit.
  - TTY + user answers "yes" → proceeds to launch.
  - `JAIPH_INPLACE_YES=1` → proceeds with no prompt (assert the prompt function is never called).
  - Non-TTY without `JAIPH_INPLACE_YES` → fails with `E_DOCKER_INPLACE_NO_CONFIRM`.
  - The warning text has three variants — clean git tree, dirty git tree, no git repo — and each names the directory and states the correct recovery posture (reversible via git / mixed-in & not cleanly undoable / irreversible). Assert all three.
- `JAIPH_INPLACE` and `JAIPH_INPLACE_YES` are not forwarded into the container (assert against the `-e` args / `isEnvAllowed`).
- The run banner reports `inplace` distinctly from `overlay`/`copy`.

***

## Add `jaiph run` flags: `--workspace`, `--inplace`, `--unsafe`, `--yes` (CLI front-ends for sandbox env switches)

### Context

`jaiph run` (and the bare `jaiph <file.jh>` form, which routes to the same code) parses its own flags in `parseArgs` (`src/cli/shared/usage.ts`, lines ~87-112): today it understands `--target <dir>`, `--raw`, and `--` (end-of-jaiph-flags terminator; everything after `--` is workflow args). The workflow file + workflow args come back as `positional`; `run.ts` does `runArgs = positional.slice(1)` (line ~81).

The sandbox/runtime currently has **no CLI surface** — it is configured purely by env vars read in `src/runtime/docker.ts`:
- `JAIPH_UNSAFE=true` → sandbox off entirely (`resolveDockerConfig` → `enabled=false`).
- `JAIPH_INPLACE=1` → live-host-edit sandbox mode (read in `selectSandboxMode`).
- `JAIPH_INPLACE_YES=1` → auto-confirm the in-place warning prompt.

Workspace root is auto-detected only: `run.ts` line ~87 calls `detectWorkspaceRoot(dirname(inputAbs))` with no override. The sibling `jaiph compile` command already exposes `--workspace <dir>` (`src/cli/commands/compile.ts` lines ~66-72, 101-104; `workspaceFlag ?? detectWorkspaceRoot(...)`) — mirror that exactly.

This task adds first-class CLI flags so users don't have to set env vars, while keeping env vars working. **The env layer stays the single source of truth:** flags are normalized into the runtime env map (and the resolved workspace path) *before* `resolveDockerConfig`/`selectSandboxMode` are called. Do not thread new parameters through `spawnDockerProcess`/`buildDockerArgs`; do not duplicate the mode-selection logic.

> Note: this task assumes `JAIPH_INPLACE` / `JAIPH_INPLACE_YES` / the `inplace` mode exist (added by the in-place sandbox task above). `JAIPH_UNSAFE` already exists today.

### Scope / required changes

1. **Flag parsing** (`src/cli/shared/usage.ts`, `parseArgs`)
   - Add to the return type and parse, stopping at `--` exactly like the existing flags:
     - `--workspace <dir>` → `workspace?: string` (requires a value; error `--workspace requires a directory path`, matching the `--target` style).
     - `--inplace` → `inplace?: boolean`.
     - `--unsafe` → `unsafe?: boolean`.
     - `--yes` / `-y` → `yes?: boolean` (auto-confirm).
   - Update `printUsage()` with the new `jaiph run` options and at least one example (`jaiph run --inplace --workspace ./app ./flows/fix.jh`).

2. **Wiring** (`src/cli/commands/run.ts`)
   - Resolve workspace: `const workspaceRoot = workspaceFlag ? resolve(workspaceFlag) : detectWorkspaceRoot(dirname(inputAbs))`. The explicit path must win. (Validate it exists / is a directory with a clear error.)
   - Normalize the boolean flags into the runtime env map that the docker layer reads, treating flag-or-env as ON (flag does not need to override a conflicting env — both enabling paths agree):
     - `--inplace` → ensure `JAIPH_INPLACE=1` in the env passed to `resolveDockerConfig`/`selectSandboxMode`.
     - `--unsafe` → ensure `JAIPH_UNSAFE=true`.
     - `--yes` → ensure `JAIPH_INPLACE_YES=1`.
   - This normalization happens before `resolveDockerConfig`/`selectSandboxMode` consume the env, i.e. applied to the `runtimeEnv` object right after `resolveRuntimeEnv` builds it (it returns a fresh spread of `process.env`). **Mutate that local object only — never `process.env`** (otherwise flags would leak into every child process globally).
   - Note (intentional asymmetry, document in code/usage): these flags only affect `jaiph run`, while the corresponding env vars also influence other entry points such as `jaiph test`. This is expected; the flags are an ergonomic front-end for `run`, not a global override.

3. **Conflicts**
   - `--inplace` together with `--unsafe` is contradictory (one keeps the sandbox on, the other turns it off). Fail fast with a clear `E_FLAG_CONFLICT` error. Same if the resolved env ends up with both `JAIPH_INPLACE` and `JAIPH_UNSAFE` truthy via mixed flag/env.

### Out of scope

- A `--workspace` *env* equivalent (the name `JAIPH_WORKSPACE` is already taken as the remap **output** in `remapDockerEnv`; do not repurpose it as an input).
- Any change to mode mechanics, mounts, or the confirm prompt itself (owned by the in-place sandbox task).

### Acceptance criteria (each verified by a test that fails when violated)

- `parseArgs` returns the new fields and still routes post-`--` tokens to `positional` unchanged (e.g. `run --inplace -- --inplace` → `inplace:true` and `positional` contains the literal `--inplace` as a workflow arg). Existing `--target`/`--raw`/`--` behavior is unchanged (regression test).
- `--workspace <dir>` makes `run` use that resolved path as `workspaceRoot` instead of `detectWorkspaceRoot`; a missing value errors; a non-existent dir errors.
- `--inplace` causes `selectSandboxMode` to resolve to `inplace` with no `JAIPH_INPLACE` env set (i.e. the flag alone is sufficient).
- `--unsafe` causes `resolveDockerConfig().enabled === false` with no `JAIPH_UNSAFE` env set.
- `--yes` causes the in-place confirm prompt to be skipped (prompt function never called) with no `JAIPH_INPLACE_YES` env set.
- Flag and env agree: setting only the env var still works (regression), and setting both flag and env is not an error.
- `--inplace --unsafe` (or the mixed flag/env equivalent) fails with `E_FLAG_CONFLICT` and launches no container.
- `printUsage()` output lists `--workspace`, `--inplace`, `--unsafe`, `--yes` under `jaiph run`.
