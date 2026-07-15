import { basename, resolve } from "node:path";
import type { JaiphConfig } from "../../config";
import type { EnvSpec } from "../shared/usage";

/**
 * Resolve `--env` specs into a flat `KEY -> value` record, ready to apply to a
 * runner env (host modes) or thread through `DockerSpawnOptions.extraEnv`
 * (Docker). Must run **before** any process is spawned so a bare `--env KEY`
 * whose value is unset on the host aborts with `E_ENV_MISSING` rather than
 * silently dropping. Later duplicates win (flag order). Name-shape and
 * reserved-key rejection already happened at parse time (`parseArgs`).
 */
export function resolveEnvPairs(
  specs: EnvSpec[],
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.value !== undefined) {
      out[spec.key] = spec.value;
    } else {
      const hostValue = hostEnv[spec.key];
      if (hostValue === undefined) {
        throw new Error(
          `E_ENV_MISSING --env ${spec.key}: no value given and ${spec.key} is not set on the host`,
        );
      }
      out[spec.key] = hostValue;
    }
  }
  return out;
}

/**
 * Boolean sandbox flags from `jaiph run`'s CLI surface. These are an ergonomic
 * front-end for the corresponding env vars: each flag turns the env var ON for
 * this run only. Both enabling paths (flag or env) agree, so the env layer
 * stays the single source of truth that `resolveDockerConfig` / `selectSandboxMode`
 * consume — no parameter threading through the docker layer.
 */
export interface SandboxFlags {
  inplace?: boolean;
  unsafe?: boolean;
  yes?: boolean;
}

/**
 * Apply sandbox flags to a runtime env map by mutating it in place.
 *
 * Mutate the local `env` only — never `process.env`, which would leak flag
 * choices into every child process globally. `resolveRuntimeEnv` always
 * returns a fresh spread of `process.env`, so callers can safely mutate it.
 *
 * Fails fast with `E_FLAG_CONFLICT` when `--inplace` / `JAIPH_INPLACE` and
 * `--unsafe` / `JAIPH_UNSAFE` are both truthy: one keeps the sandbox on,
 * the other turns it off.
 */
export function applySandboxFlags(
  env: Record<string, string | undefined>,
  flags: SandboxFlags,
): void {
  if (flags.inplace) env.JAIPH_INPLACE = "1";
  if (flags.unsafe) env.JAIPH_UNSAFE = "true";
  if (flags.yes) env.JAIPH_INPLACE_YES = "1";

  const inplaceOn = env.JAIPH_INPLACE === "1" || env.JAIPH_INPLACE === "true";
  const unsafeOn = env.JAIPH_UNSAFE === "true";
  if (inplaceOn && unsafeOn) {
    throw new Error(
      "E_FLAG_CONFLICT --inplace / JAIPH_INPLACE and --unsafe / JAIPH_UNSAFE are mutually exclusive: " +
        "in-place mode keeps the sandbox on with the host workspace bind-mounted rw, while unsafe disables the sandbox entirely.",
    );
  }
}

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
