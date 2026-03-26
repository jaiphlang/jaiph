import { resolve } from "node:path";
import { build } from "../../transpiler";
import { parseArgs } from "../shared/usage";

export function runBuild(rest: string[]): number {
  const { target, positional } = parseArgs(rest);
  const input = positional[0] ?? "./";
  const results = build(input, target);
  for (const item of results) {
    process.stdout.write(`built ${resolve(item.outputPath)}\n`);
  }
  if (results.length === 0) {
    process.stdout.write("no .jh files found\n");
  }
  return 0;
}
