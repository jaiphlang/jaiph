import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * Build argv/env for executing a workflow via the Node runtime.
 * Positional args: [meta_file, built_script, workflow_symbol, ...run_args]
 */
export function buildRunModuleLaunch(
  positionalArgs: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [metaFile, builtScript, workflowSymbol, ...runArgs] = positionalArgs;
  if (!metaFile || !builtScript) {
    throw new Error("jaiph run launch requires meta_file and built_script");
  }
  const sourceAbs = env.JAIPH_SOURCE_ABS;
  if (!sourceAbs) {
    throw new Error("JAIPH_SOURCE_ABS is required for workflow launch");
  }
  const runnerPath = join(__dirname, "node-workflow-runner.js");
  return {
    command: process.execPath,
    args: [runnerPath, metaFile, sourceAbs, builtScript, workflowSymbol || "default", ...runArgs],
    env: { ...env, JAIPH_META_FILE: metaFile },
  };
}

/** Spawn the detached workflow leader used by `jaiph run`. */
export function spawnJaiphWorkflowProcess(
  positionalArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: "pipe" | "inherit" },
): ChildProcess {
  const launch = buildRunModuleLaunch(positionalArgs, options.env);
  return spawn(launch.command, launch.args, {
    stdio: options.stdio ?? "pipe",
    cwd: options.cwd,
    env: launch.env,
    detached: true,
  });
}
