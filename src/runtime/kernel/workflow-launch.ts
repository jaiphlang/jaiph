import { spawn, ChildProcess } from "node:child_process";

/**
 * Build argv/env for directly executing a transpiled workflow module.
 * Positional args keep the existing launch contract:
 * [meta_file, built_script, workflow_symbol, ...run_args]
 */
export function buildRunModuleLaunch(
  positionalArgs: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [metaFile, builtScript, _workflowSymbol, ...runArgs] = positionalArgs;
  if (!metaFile || !builtScript) {
    throw new Error("jaiph run launch requires meta_file and built_script");
  }
  return {
    command: builtScript,
    args: ["__jaiph_workflow", "default", ...runArgs],
    env: { ...env, JAIPH_META_FILE: metaFile },
  };
}

/** Spawn the detached workflow leader used by `jaiph run`. */
export function spawnJaiphWorkflowProcess(
  positionalArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const launch = buildRunModuleLaunch(positionalArgs, options.env);
  return spawn(launch.command, launch.args, {
    stdio: "pipe",
    cwd: options.cwd,
    env: launch.env,
    detached: true,
  });
}
