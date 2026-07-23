// Reserved environment-key policy shared by the two user-facing ways to feed
// env vars into a run: the imperative `--env` flag (`src/cli/shared/usage.ts`)
// and the declarative `trusted_envs` config key (`src/parse/metadata.ts`).
// One list, one predicate — both surfaces must reject the same keys.

/** `KEY` must be a POSIX-shell-style environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys `--env` and `trusted_envs` refuse to set (all modes):
 *  - sandbox-control keys the flags `--inplace` / `--unsafe` and the
 *    `JAIPH_DOCKER_*` family own — forwarding them would leak or re-trigger
 *    host control flags;
 *  - runtime-managed keys that `resolveRuntimeEnv` / `remapDockerEnv` compute
 *    and (in Docker) path-remap — user values pass verbatim, so allowing
 *    these would collide with the managed value.
 * Use the sandbox flags or real env vars for control keys instead.
 */
export const RESERVED_ENV_KEYS = new Set<string>([
  "JAIPH_UNSAFE",
  "JAIPH_INPLACE",
  "JAIPH_INPLACE_YES",
  "JAIPH_WORKSPACE",
  "JAIPH_RUNS_DIR",
  "JAIPH_RUN_ID",
  "JAIPH_SCRIPTS",
  "JAIPH_MODULE_GRAPH_FILE",
  "JAIPH_SOURCE_ABS",
  "JAIPH_META_FILE",
  "JAIPH_AGENT_TRUSTED_WORKSPACE",
  // Selects the inner run's root symbol in a Docker MCP call; managed via the
  // container spawn wiring, not user env.
  "JAIPH_RUN_WORKFLOW",
]);

/** True if `--env` / `trusted_envs` must reject `key` (`E_ENV_RESERVED`). */
export function isReservedEnvKey(key: string): boolean {
  if (key.startsWith("JAIPH_DOCKER_")) return true;
  return RESERVED_ENV_KEYS.has(key);
}
