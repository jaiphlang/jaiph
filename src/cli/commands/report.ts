import { runReportingCli } from "../../reporting/cli";

export async function runReportCommand(args: string[]): Promise<number> {
  return runReportingCli(args);
}
