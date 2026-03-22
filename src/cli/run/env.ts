import { basename, join, resolve } from "node:path";
import type { JaiphConfig } from "../../config";

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
 * Merges process.env with config-derived values, sets lock flags,
 * and cleans transient keys.
 */
export function resolveRuntimeEnv(
  effectiveConfig: JaiphConfig,
  workspaceRoot: string,
  inputAbs: string,
): Record<string, string | undefined> {
  const env = { ...process.env, JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;

  // Mark env-provided keys as locked so the runtime doesn't override them.
  for (const key of LOCKED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[`${key}_LOCKED`] = "1";
    }
  }

  // Apply config defaults where env is not already set.
  if (env.JAIPH_AGENT_MODEL === undefined && effectiveConfig.agent?.defaultModel) {
    env.JAIPH_AGENT_MODEL = effectiveConfig.agent.defaultModel;
  }
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
  if (env.JAIPH_STDLIB === undefined) {
    env.JAIPH_STDLIB = join(__dirname, "..", "..", "jaiph_stdlib.sh");
  }
  env.JAIPH_SOURCE_FILE = basename(inputAbs);

  // Clean transient keys that must not leak across runs.
  delete env.BASH_ENV;
  delete env.JAIPH_RUN_DIR;
  delete env.JAIPH_PRECEDING_FILES;
  delete env.JAIPH_RUN_SUMMARY_FILE;

  return env;
}
