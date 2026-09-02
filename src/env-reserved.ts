// Reserved environment-key policy shared by the two user-facing ways to name
// env vars for a run: the operator grant `--env` flag (`src/cli/shared/usage.ts`)
// and the `use` clause on script declarations (`src/parse/scripts.ts`).
// One list, one predicate — both surfaces must reject the same keys.

/** `KEY` must be a POSIX-shell-style environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys `--env` and `use` refuse to name:
 *  - runtime-managed keys that `resolveRuntimeEnv` computes;
 *  - the `--env` grant hand-off itself (`JAIPH_ENV_GRANT`);
 *  - the operator opt-in that trusts the workspace's project-local
 *    `.jaiph/hooks.json`;
 *  - the audit-chain HMAC key and journal path, which stay with the
 *    runner and must not be injectable via `use` after the prompt scrub.
 */
export const RESERVED_ENV_KEYS = new Set<string>([
  "JAIPH_WORKSPACE",
  "JAIPH_RUNS_DIR",
  "JAIPH_RUN_ID",
  "JAIPH_SCRIPTS",
  "JAIPH_MODULE_GRAPH_FILE",
  "JAIPH_SOURCE_ABS",
  "JAIPH_META_FILE",
  "JAIPH_ENV_GRANT",
  "JAIPH_AGENT_TRUSTED_WORKSPACE",
  "JAIPH_TRUST_PROJECT_HOOKS",
  "JAIPH_CHAIN_KEY",
  "JAIPH_RUN_SUMMARY_FILE",
]);

/** True if `--env` / `use` must reject `key` (`E_ENV_RESERVED`). */
export function isReservedEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key);
}
