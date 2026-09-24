# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Require a commit pin on library lockfile restore #dev-ready

Context: `jaiph install <name>` refuses a registry entry with no commit unless `--allow-unpinned`, and verifies `entry.signature` when present. `jaiph install` with no arguments restores from `.jaiph/libs.lock` and does not re-read the registry.

Problem: `specToLockEntry` in `src/cli/commands/install.ts` never writes `signature`. No-arg restore builds specs without `signature` and with `expectedCommit` only when the lock has `commit`. `postCloneHygiene` checks a commit only when `expectedCommit` is set and verifies a signature only when `spec.signature` is set. A lock entry with no `commit` clones the mutable ref. The test `install: legacy lockfile without commit field still restores` currently expects that restore to succeed.

Location: `src/cli/commands/install.ts` `specToLockEntry`, no-arg restore in `runInstall`, `postCloneHygiene`.

Remediation: Persist `signature` on the lock entry when the install spec has one. On restore, refuse an entry that has no `commit`. When a signature is present, verify it against the cloned commit with the same registry public key as named install. A lock entry that has a commit and no signature still restores only when the cloned commit matches.

### Acceptance criteria
- Change `install: legacy lockfile without commit field still restores` so a lock entry without `commit` makes `runInstall([])` exit non-zero and does not leave the lib directory.
- A test named-installs a fixture whose registry entry has a commit and a signature, then asserts `.jaiph/libs.lock` contains that signature. Delete the lib dir, corrupt the stored signature, run no-arg restore, and assert non-zero exit and no leftover lib dir.
- A test restores a lock entry that has a matching `commit` and no `signature`, and asserts success. A different cloned commit still fails the existing mismatch check.
- Named install of an unpinned registry entry still fails unless `--allow-unpinned`.

## Gate imported agent trust and flags like agent.command #dev-ready

Context: `applyMetadataScope` in `src/runtime/kernel/node-workflow-runtime.ts` applies `agent.command` and `agent.backend` from an imported module only when `fromEntryModule` is true or the matching `IMPORT_UNLOCK` env var is set. `docs/configuration.md` states that `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, and `run.logs_dir` are not restricted.

Problem: Those four keys are copied from any module onto the workflow env. `buildBackendArgs` in `src/runtime/kernel/prompt-config.ts` passes `trustedWorkspace` as Cursor `--trust` and appends `cursorFlags` and `claudeFlags` to the agent argv. An imported module can change the agent trust path, agent argv, and run directory for its own prompt steps without the entry-module gate used for the binary selector.

Location: `src/runtime/kernel/node-workflow-runtime.ts` `applyMetadataScope`; `docs/configuration.md` Import trust boundary.

Remediation: Apply the same entry-module gate to `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, and `run.logs_dir`. Add unlock env vars parallel to `JAIPH_AGENT_COMMAND_IMPORT_UNLOCK`. Keep the existing `*_LOCKED` flags winning over unlock. Update the import-trust section of `docs/configuration.md` to match.

### Acceptance criteria
- A runtime test imports a child module that sets `agent.trusted_workspace`, `agent.cursor_flags`, and `run.logs_dir`. Without unlock env vars, the child scope does not receive those values. With the new unlock vars set, the child scope does.
- The entry module can still set the same keys with no unlock var.
- `JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED=1` still blocks an overwrite from metadata, including when unlock is set.
- `docs/configuration.md` no longer says those keys are unrestricted on cross-module calls.
- The test fails if `applyMetadataScope` assigns those keys when `fromEntryModule` is false and unlock is unset.
