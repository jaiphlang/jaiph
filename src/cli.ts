#!/usr/bin/env node
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build, workflowSymbolForFile } from "./transpiler";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph build [--target <dir>] <path>",
      "  jaiph run [--target <dir>] <file.jph|file.jh|file.jrh> [args...]",
      "",
      "Examples:",
      "  jaiph build ./",
      "  jaiph build --target ./build ./",
      "  jaiph run ./flows/review.jph 'review this diff'",
      "",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): { target?: string; positional: string[] } {
  let target: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--target") {
      const val = args[i + 1];
      if (!val) {
        throw new Error("--target requires a directory path");
      }
      target = val;
      i += 1;
      continue;
    }
    if (args[i] === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    positional.push(args[i]);
  }
  return { target, positional };
}

function runBuild(rest: string[]): number {
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

function runWorkflow(rest: string[]): number {
  const { target, positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);
  if (!input) {
    process.stderr.write("jaiph run requires a .jph/.jh/.jrh file path\n");
    return 1;
  }
  const inputAbs = resolve(input);
  const inputStat = statSync(inputAbs);
  if (!inputStat.isFile() || ![".jph", ".jh", ".jrh"].includes(extname(inputAbs))) {
    process.stderr.write("jaiph run expects a single .jph, .jh or .jrh file\n");
    return 1;
  }

  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const results = build(inputAbs, outDir);
    if (results.length !== 1) {
      process.stderr.write(`jaiph run expected one built output, got ${results.length}\n`);
      return 1;
    }
    const builtPath = results[0].outputPath;
    const workflowSymbol = workflowSymbolForFile(inputAbs, dirname(inputAbs));
    const command = [
      'built_script="$1"; shift',
      'workflow_symbol="$1"; shift',
      'source "$built_script"',
      'entrypoint="${workflow_symbol}__workflow_default"',
      'if ! declare -F "$entrypoint" >/dev/null; then',
      '  echo "jaiph run requires workflow \'default\' in the input file" >&2',
      "  exit 1",
      "fi",
      '"$entrypoint" "$@"',
    ].join("\n");
    const execResult = spawnSync(
      "bash",
      ["-c", command, "jaiph-run", builtPath, workflowSymbol, ...runArgs],
      {
      stdio: "inherit",
      },
    );
    if (typeof execResult.status === "number") {
      return execResult.status;
    }
    return 1;
  } finally {
    if (shouldCleanup) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

function main(argv: string[]): number {
  const [, , cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return 0;
  }
  try {
    if (cmd === "build") {
      return runBuild(rest);
    }
    if (cmd === "run") {
      return runWorkflow(rest);
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

process.exit(main(process.argv));
