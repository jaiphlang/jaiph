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
