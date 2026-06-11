import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { WORKFLOW_RUNNER_ARG } from "./node-workflow-runner";

/**
 * True when the running process is the bun --compile standalone binary.
 *
 * In that mode `process.execPath` points at the jaiph binary itself, so a
 * spawn must use `[jaiph, __workflow-runner, ...]` argv. Under node it points
 * at the node interpreter and the spawn needs `[node, cli.js, __workflow-runner, ...]`.
 */
function isBunCompiledStandalone(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Build argv/env for executing a workflow via the Node runtime.
 * Positional args: [meta_file, built_script, workflow_symbol, ...run_args]
 */
export function buildRunModuleLaunch(
  positionalArgs: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [metaFile, builtScript, _workflowSymbol, ...runArgs] = positionalArgs;
  if (!metaFile || !builtScript) {
    throw new Error("jaiph run launch requires meta_file and built_script");
  }
  const sourceAbs = env.JAIPH_SOURCE_ABS;
  if (!sourceAbs) {
    throw new Error("JAIPH_SOURCE_ABS is required for workflow launch");
  }
  const runnerArgv = [WORKFLOW_RUNNER_ARG, metaFile, sourceAbs, builtScript, "default", ...runArgs];
  const launchEnv = { ...env, JAIPH_META_FILE: metaFile };
  if (isBunCompiledStandalone()) {
    return { command: process.execPath, args: runnerArgv, env: launchEnv };
  }
  return {
    command: process.execPath,
    args: [join(__dirname, "..", "..", "cli.js"), ...runnerArgv],
    env: launchEnv,
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
