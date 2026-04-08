import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { printUsage } from "./shared/usage";
import { runWorkflow } from "./commands/run";
import { runTest } from "./commands/test";
import { runInit } from "./commands/init";
import { runUse } from "./commands/use";
import { runReportCommand } from "./commands/report";
import { runFormat } from "./commands/format";
import { runInstall } from "./commands/install";

export async function main(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("jaiph 0.8.0\n");
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
      return runInstall(rest);
    }
    if (cmd === "report") {
      return runReportCommand(rest);
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
