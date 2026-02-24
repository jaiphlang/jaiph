#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build, workflowSymbolForFile } from "./transpiler";
import { parsejaiph } from "./parser";
import { WorkflowStepDef, jaiphModule } from "./types";

function colorPalette(): { green: string; red: string; dim: string; reset: string } {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return { green: "", red: "", dim: "", reset: "" };
  }
  return {
    green: "\u001b[32m",
    red: "\u001b[31m",
    dim: "\u001b[2m",
    reset: "\u001b[0m",
  };
}

function collectWorkflowChildren(mod: jaiphModule, workflowName: string): Array<{ label: string; nested?: string }> {
  const workflow = mod.workflows.find((item) => item.name === workflowName);
  if (!workflow) {
    return [];
  }
  const items: Array<{ label: string; nested?: string }> = [];
  for (const step of workflow.steps) {
    if (step.type === "ensure") {
      items.push({ label: `rule ${step.ref.value}` });
      continue;
    }
    if (step.type === "run") {
      items.push({ label: `workflow ${step.workflow.value}`, nested: step.workflow.value });
      continue;
    }
    if (step.type === "if_not_ensure_then_run") {
      items.push({ label: `rule ${step.ensureRef.value}` });
      items.push({ label: `workflow ${step.runWorkflow.value}`, nested: step.runWorkflow.value });
      continue;
    }
  }
  return items;
}

function renderRunTree(mod: jaiphModule): string {
  const lines = ["workflow default"];
  const visited = new Set<string>(["default"]);

  const renderChildren = (workflowName: string, prefix: string): void => {
    const children = collectWorkflowChildren(mod, workflowName);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${branch}${child.label}`);
      if (!child.nested) {
        continue;
      }
      if (child.nested.includes(".") || visited.has(child.nested)) {
        continue;
      }
      visited.add(child.nested);
      renderChildren(child.nested, `${prefix}${isLast ? "    " : "│   "}`);
    }
  };

  renderChildren("default", "");
  return lines.join("\n");
}

function summarizeError(stderr: string, fallback?: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    return lines[lines.length - 1];
  }
  return fallback ?? "Workflow execution failed.";
}

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
    const mod = parsejaiph(readFileSync(inputAbs, "utf8"), inputAbs);
    process.stdout.write(`${renderRunTree(mod)}\n`);

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
    const startedAt = Date.now();
    const execResult = spawnSync(
      "bash",
      ["-c", command, "jaiph-run", builtPath, workflowSymbol, ...runArgs],
      {
        stdio: "pipe",
        encoding: "utf8",
      },
    );
    const elapsedMs = Date.now() - startedAt;
    if (execResult.stdout) {
      process.stdout.write(execResult.stdout);
    }

    const palette = colorPalette();
    if (execResult.status === 0) {
      if (execResult.stderr) {
        process.stderr.write(execResult.stderr);
      }
      process.stdout.write(
        `${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedMs}ms)${palette.reset}\n`,
      );
      return 0;
    }

    const summary = summarizeError(execResult.stderr ?? "", execResult.error?.message);
    process.stderr.write(
      `${palette.red}\u2717 FAIL${palette.reset} workflow default ${palette.dim}(${elapsedMs}ms)${palette.reset}\n`,
    );
    process.stderr.write(`  ${summary}\n`);

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
