// Reserved environment-key policy shared by the two user-facing ways to feed
// env vars into a run: the imperative `--env` flag (`src/cli/shared/usage.ts`)
// and the declarative `trusted_envs` config key (`src/parse/metadata.ts`).
// One list, one predicate — both surfaces must reject the same keys.

/** `KEY` must be a POSIX-shell-style environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys `--env` and `trusted_envs` refuse to set:
 *  - runtime-managed keys that `resolveRuntimeEnv` computes;
 *  - the operator opt-in that trusts the workspace's project-local
 *    `.jaiph/hooks.json` (finding M-10).
 */
export const RESERVED_ENV_KEYS = new Set<string>([
  "JAIPH_WORKSPACE",
  "JAIPH_RUNS_DIR",
  "JAIPH_RUN_ID",
  "JAIPH_SCRIPTS",
  "JAIPH_MODULE_GRAPH_FILE",
  "JAIPH_SOURCE_ABS",
  "JAIPH_META_FILE",
  "JAIPH_AGENT_TRUSTED_WORKSPACE",
  "JAIPH_TRUST_PROJECT_HOOKS",
]);

/** True if `--env` / `trusted_envs` must reject `key` (`E_ENV_RESERVED`). */
export function isReservedEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key);
}
