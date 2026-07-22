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

## Fix: Ship a tailored AppArmor profile for overlay mode

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 3 (LOW, ASI-03/ASI-05) — the tracked exception left by "Prefer `copy` over elevated overlay defaults; document overlay capability posture" (overlay default kept; posture documented in `docs/sandboxing.md#overlay-capability-posture` and locked by tests in `src/runtime/docker.test.ts`).

**Problem:** Overlay mode on Linux runs with `--security-opt apparmor=unconfined` because default host AppArmor profiles deny fuse mounts inside containers, and Docker can only reference profiles already loaded on the host — which the unprivileged CLI cannot do. Unconfined is broader than the fuse mount requires.

**Required behavior:**

* Ship a loadable AppArmor profile (docker-default semantics plus `mount fstype=fuse`) under `runtime/`, with a documented `apparmor_parser` install step for hosts that opt in.
* When that profile is loaded on the host, `buildDockerArgs` prefers `--security-opt apparmor=<profile>` for overlay containers; when it is not loaded, fall back to `apparmor=unconfined` (current posture) so overlay keeps working out of the box.
* Update the overlay posture section in `docs/sandboxing.md` and the posture-lock tests in `src/runtime/docker.test.ts` for both branches.

Acceptance:

* Overlay containers use the tailored profile when it is loaded and `unconfined` otherwise, with unit tests covering both branches (profile-detection injectable for tests).
* Docs describe how to load the profile and exactly what it permits beyond docker-default.
* `npm test` passes.

***

## Fix: Keep injected credentials out of prompt agent subprocesses #dev-ready

**Source:** Security review of the `--env` credential path. A `.jh` script that needs a credential (e.g. `jaiph run --env GITHUB_TOKEN .jaiph/gh_ci_passes.jh`) currently leaks that credential into the LLM agent's environment, even though only trusted `run` steps need it.

**Problem:** The prompt agent inherits the full workflow env. In `runBackend` (`src/runtime/kernel/prompt.ts:584`) `childEnv` defaults to `execEnv` (the workflow's `scope.env`, itself a spread of `process.env` plus everything merged from `--env`). For the Claude backend, `prepareClaudeEnv` (`prompt.ts:~316`) only *augments* the env (adds `CLAUDE_CONFIG_DIR`); it never strips. So the `claude` subprocess — spawned with `--permission-mode bypassPermissions` and fed untrusted content such as CI failure logs — receives `GITHUB_TOKEN` and every other `--env` secret. This bypasses the fail-closed per-backend allowlist that already exists for the Docker boundary (`isEnvAllowed`/`BACKEND_CREDENTIAL_KEYS` at `src/runtime/docker.ts:640/593`); in host mode there is no allowlist at all (`src/cli/commands/run.ts:161`), and `--env` values cross the Docker boundary verbatim (`docker.ts:853`).

Trust model context: `run <ref>` executes deterministic author-written stdlib via `executeRunRef` (`src/runtime/kernel/node-workflow-runtime.ts:1286`); only `prompt` hands control to the model. Credentials should therefore be visible to `run` steps and never to `prompt` steps. The read-side ops (`gh_actions.sh`: `gh run list/watch/view --log`) are trusted `run` steps and read-only; the one credentialed write (push) is already a trusted `run git.push(...)` step in `.jaiph/` (do not edit `.jaiph/` in this task — it is out of scope and already handled). Local editing and local `git commit` need no credential. Therefore no `prompt` step legitimately needs an `--env`-injected secret, and this scrub can be applied unconditionally.

**Required behavior:**

* When spawning any prompt backend, pass an allowlisted environment instead of `execEnv` verbatim: forward `JAIPH_*` control keys and the agent's *own* backend credential (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` for Claude, `CURSOR_API_KEY`, `OPENAI_API_KEY` per backend) and drop everything else, fail-closed. Reuse/lift the existing `isEnvAllowed`/`BACKEND_CREDENTIAL_KEYS` logic (`docker.ts:640/593`) so the same allowlist governs prompt subprocesses in *all* sandbox modes, including host mode.
* Non-credential env the agent legitimately needs (e.g. `PATH`, `HOME`, locale, `CLAUDE_CONFIG_DIR`) must still pass — the allowlist strips secrets, not the base environment.

Acceptance:

* A unit test asserts that the env handed to a prompt backend subprocess excludes an injected non-allowlisted secret (e.g. a fake `GITHUB_TOKEN`) while still including the base env and the backend's own credential key; the test fails if the agent env contains the secret. Cover host mode and at least one Docker mode.
* A regression test asserts a trusted `run` step (script/workflow) still receives the full `--env`-injected value, so scrubbing is scoped to `prompt` subprocesses only and does not break credentialed `run` steps.
* `npm test` passes.

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
