import { basename, resolve } from "node:path";
import type { JaiphConfig } from "../../config";
import { buildRunnerBaseEnv, isRunnerEnvAllowed, writeEnvGrantFile, ENV_GRANT_FILE_ENV } from "../../runtime";

// `--env` spec resolution (`resolveEnvPairs`) lives beside `EnvSpec` in
// `../shared/usage.ts` — the shared flag surface for run, serve, mcp, and test.

const LOCKED_ENV_KEYS = [
  "JAIPH_AGENT_MODEL",
  "JAIPH_AGENT_COMMAND",
  "JAIPH_AGENT_BACKEND",
  "JAIPH_AGENT_TRUSTED_WORKSPACE",
  "JAIPH_AGENT_CURSOR_FLAGS",
  "JAIPH_AGENT_CLAUDE_FLAGS",
  "JAIPH_RUNS_DIR",
  "JAIPH_DEBUG",
] as const;

/**
 * Build the runtime environment for a workflow process.
 * Starts from an allowlist of the host env (`buildRunnerBaseEnv`, not a copy of
 * `process.env`), layers config-derived values, sets lock flags, and cleans
 * transient keys. Ungranted host secrets never ride on the runner env; `--env`
 * grant values are applied off-process by `applyEnvGrant`.
 */
export function resolveRuntimeEnv(
  effectiveConfig: JaiphConfig,
  workspaceRoot: string,
  inputAbs: string,
): Record<string, string | undefined> {
  const env = { ...buildRunnerBaseEnv(process.env), JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;

  // Mark env-provided keys as locked so the runtime doesn't override them.
  for (const key of LOCKED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[`${key}_LOCKED`] = "1";
    }
  }

  // Apply config defaults where env is not already set.
  if (env.JAIPH_AGENT_COMMAND === undefined && effectiveConfig.agent?.command) {
    env.JAIPH_AGENT_COMMAND = effectiveConfig.agent.command;
  }
  if (env.JAIPH_AGENT_BACKEND === undefined && effectiveConfig.agent?.backend) {
    env.JAIPH_AGENT_BACKEND = effectiveConfig.agent.backend;
  }
  if (env.JAIPH_AGENT_TRUSTED_WORKSPACE === undefined) {
    if (effectiveConfig.agent?.trustedWorkspace) {
      env.JAIPH_AGENT_TRUSTED_WORKSPACE = resolve(workspaceRoot, effectiveConfig.agent.trustedWorkspace);
    } else {
      env.JAIPH_AGENT_TRUSTED_WORKSPACE = workspaceRoot;
    }
  }
  if (env.JAIPH_AGENT_CURSOR_FLAGS === undefined && effectiveConfig.agent?.cursorFlags) {
    env.JAIPH_AGENT_CURSOR_FLAGS = effectiveConfig.agent.cursorFlags;
  }
  if (env.JAIPH_AGENT_CLAUDE_FLAGS === undefined && effectiveConfig.agent?.claudeFlags) {
    env.JAIPH_AGENT_CLAUDE_FLAGS = effectiveConfig.agent.claudeFlags;
  }
  if (env.JAIPH_RUNS_DIR === undefined && effectiveConfig.run?.logsDir) {
    env.JAIPH_RUNS_DIR = effectiveConfig.run.logsDir;
  }
  if (env.JAIPH_DEBUG === undefined && effectiveConfig.run?.debug === true) {
    env.JAIPH_DEBUG = "true";
  }
  // agent.model is prompt-scoped and no longer maps into JAIPH_AGENT_MODEL, which
  // stays a shell-only run-wide override. Keep it defined (empty) so scripts that
  // read $JAIPH_AGENT_MODEL under `set -u` see an empty value instead of tripping
  // "unbound variable".
  if (env.JAIPH_AGENT_MODEL === undefined) {
    env.JAIPH_AGENT_MODEL = "";
  }
  env.JAIPH_SOURCE_FILE = basename(inputAbs);
  // JAIPH_STDLIB is no longer used; clean it from inherited env.
  delete env.JAIPH_STDLIB;

  // Clean transient keys that must not leak across runs.
  delete env.BASH_ENV;
  delete env.JAIPH_META_FILE;
  delete env.JAIPH_RUN_DIR;
  delete env.JAIPH_ARTIFACTS_DIR;
  delete env.JAIPH_PRECEDING_FILES;
  delete env.JAIPH_RUN_SUMMARY_FILE;
  // A parent shell may export JAIPH_SCRIPTS for its own module (e.g. nested `jaiph run` → npm → tests).
  // `jaiph run` always builds scripts under that run's output dir; inherited JAIPH_SCRIPTS would shadow
  // the per-module default in the emitted `export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd ...)}"`.
  delete env.JAIPH_SCRIPTS;
  // Same for the serialized module graph: each run must load/build the graph for its own entry file.
  // Inherited JAIPH_MODULE_GRAPH_FILE (e.g. from `npm test` after a prior jaiph run) would make
  // `jaiph run --raw` execute the wrong workflows.
  delete env.JAIPH_MODULE_GRAPH_FILE;
  // Strip stale JAIPH_LIB from a parent shell (removed from the product; scripts use JAIPH_WORKSPACE).
  delete env.JAIPH_LIB;

  return env;
}

/**
 * Apply the `--env` grant to a runner env. The grant *names* go on
 * `JAIPH_ENV_GRANT` (always, so a stale inherited grant never leaks — set even
 * when empty), and every granted value is written to a private tmpdir grant
 * file (outside the workspace and the run dir) that the detached leader reads
 * into its in-memory grant map — the only source of `use` values.
 *
 * A granted key lands on the runner process env **only** when it is
 * runner-allowlisted (`isRunnerEnvAllowed`: process basics, `JAIPH_*` control
 * keys, backend credentials) — those are runner configuration a host-set value
 * would also carry, not a `use` secret. Everything else (a `GITHUB_TOKEN` and
 * friends) stays off the runner env entirely; a `use` subprocess reaches it only
 * through the off-process grant map. So `jaiph run --env GITHUB_TOKEN` never puts
 * `GITHUB_TOKEN` on the workflow-leader process environment.
 *
 * Returns the grant file path so the caller can remove its dir after the run
 * (the leader also removes it on read).
 */
export function applyEnvGrant(
  runtimeEnv: Record<string, string | undefined>,
  extraEnv: Record<string, string>,
): { grantFile: string | undefined } {
  runtimeEnv.JAIPH_ENV_GRANT = Object.keys(extraEnv).join(",");
  for (const [key, value] of Object.entries(extraEnv)) {
    // Non-allowlisted secrets must never sit on the runner env, even if an
    // inherited value happened to be there; allowlisted config keys may.
    if (isRunnerEnvAllowed(key)) runtimeEnv[key] = value;
    else delete runtimeEnv[key];
  }
  if (Object.keys(extraEnv).length === 0) {
    delete runtimeEnv[ENV_GRANT_FILE_ENV];
    return { grantFile: undefined };
  }
  const grantFile = writeEnvGrantFile(extraEnv);
  runtimeEnv[ENV_GRANT_FILE_ENV] = grantFile;
  return { grantFile };
}
