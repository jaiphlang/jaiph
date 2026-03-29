import { basename, resolve } from "node:path";
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
  "JAIPH_INBOX_PARALLEL",
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
  if (env.JAIPH_INBOX_PARALLEL === undefined && effectiveConfig.run?.inboxParallel === true) {
    env.JAIPH_INBOX_PARALLEL = "true";
  }
  env.JAIPH_SOURCE_FILE = basename(inputAbs);
  // JAIPH_STDLIB is no longer used; clean it from inherited env.
  delete env.JAIPH_STDLIB;

  // Clean transient keys that must not leak across runs.
  delete env.BASH_ENV;
  delete env.JAIPH_META_FILE;
  delete env.JAIPH_RUN_DIR;
  delete env.JAIPH_PRECEDING_FILES;
  delete env.JAIPH_RUN_SUMMARY_FILE;
  // A parent shell may export JAIPH_SCRIPTS for its own module (e.g. nested `jaiph run` → npm → tests).
  // `jaiph run` always builds scripts under that run's output dir; inherited JAIPH_SCRIPTS would shadow
  // the per-module default in the emitted `export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd ...)}"`.
  delete env.JAIPH_SCRIPTS;
  // Same for the workflow module path: a parent shell or nested tool may export this; the emitted
  // module only sets JAIPH_RUN_STEP_MODULE when unset, so a stale path would break run-step-exec.
  delete env.JAIPH_RUN_STEP_MODULE;

  return env;
}
