import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { printUsage } from "./shared/usage";
import { runWorkflow } from "./commands/run";
import { runTest } from "./commands/test";
import { runInit } from "./commands/init";
import { runUse } from "./commands/use";
import { runFormat } from "./commands/format";
import { runInstall } from "./commands/install";
import { runCompile } from "./commands/compile";
import { runMcp } from "./commands/mcp";
import { runWorkflowRunner, WORKFLOW_RUNNER_ARG } from "../runtime/kernel/node-workflow-runner";
import { VERSION } from "../version";

export async function main(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;
  // Internal self-spawn dispatch: the bun-compiled binary spawns itself with
  // `__workflow-runner` to enter the workflow leader. Must run before help,
  // version, or file-shorthand checks so the reserved marker never leaks into
  // user-visible paths. Excluded from `printUsage` for the same reason.
  if (cmd === WORKFLOW_RUNNER_ARG) {
    try {
      return await runWorkflowRunner(rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`jaiph node runner: ${message}\n`);
      return 1;
    }
  }
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`jaiph ${VERSION}\n`);
    return 0;
  }
  try {
    if (cmd.endsWith(".test.jh") && existsSync(resolve(cmd))) {
      return await runTest([cmd, ...rest]);
    }
    if (cmd.endsWith(".jh") && existsSync(resolve(cmd))) {
      return runWorkflow([cmd, ...rest]);
    }
    if (cmd === "run") {
      return runWorkflow(rest);
    }
    if (cmd === "test") {
      return await runTest(rest);
    }
    if (cmd === "init") {
      return runInit(rest);
    }
    if (cmd === "use") {
      return runUse(rest);
    }
    if (cmd === "format") {
      return runFormat(rest);
    }
    if (cmd === "install") {
      return await runInstall(rest);
    }
    if (cmd === "compile") {
      return runCompile(rest);
    }
    // `--mcp` is an ergonomic alias for the `mcp` subcommand (`jaiph --mcp tools.jh`).
    if (cmd === "mcp" || cmd === "--mcp") {
      return await runMcp(rest);
    }
    process.stderr.write(`Unknown command: ${cmd}\n`);
    printUsage();
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

export function runCli(argv: string[]): void {
  main(argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
