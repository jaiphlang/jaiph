#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build, workflowSymbolForFile } from "./transpiler";
import { parsejaiph } from "./parser";
import { jaiphModule } from "./types";

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

type RunMeta = {
  output: string;
  status?: number;
  runDir?: string;
};

function extractRunMeta(output: string): RunMeta {
  const lines = output.split(/\r?\n/);
  const visible: string[] = [];
  let status: number | undefined;
  let runDir: string | undefined;
  for (const line of lines) {
    if (line.startsWith("__JAIPH_META_STATUS__:")) {
      const raw = line.slice("__JAIPH_META_STATUS__:".length).trim();
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        status = parsed;
      }
      continue;
    }
    if (line.startsWith("__JAIPH_META_RUN_DIR__:")) {
      const raw = line.slice("__JAIPH_META_RUN_DIR__:".length).trim();
      if (raw) {
        runDir = raw;
      }
      continue;
    }
    visible.push(line);
  }
  return {
    output: visible.join("\n").trimEnd(),
    status,
    runDir,
  };
}

function latestRunFiles(runDir: string): { out?: string; err?: string } {
  try {
    const files = readdirSync(runDir).sort();
    const out = [...files].reverse().find((name) => name.endsWith(".out"));
    const err = [...files].reverse().find((name) => name.endsWith(".err"));
    return {
      out: out ? join(runDir, out) : undefined,
      err: err ? join(runDir, err) : undefined,
    };
  } catch {
    return {};
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph build [--target <dir>] <path>",
      "  jaiph run [--target <dir>] <file.jph|file.jh|file.jrh> [args...]",
      "  jaiph init [workspace-path]",
      "",
      "Examples:",
      "  jaiph build ./",
      "  jaiph build --target ./build ./",
      "  jaiph run ./flows/review.jph 'review this diff'",
      "  jaiph init",
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

function detectWorkspaceRoot(startDir: string): string {
  const fallback = resolve(startDir);
  let current = fallback;
  while (true) {
    if (existsSync(join(current, ".jaiph")) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return fallback;
    }
    current = parent;
  }
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

const BOOTSTRAP_TEMPLATE = `# Bootstraps Jaiph workflows for this repository.
workflow default {
  prompt "
    You are bootstrapping Jaiph for this repository.
    First, read the Jaiph agent bootstrap guide at:
    https://github.com/jaiphlang/jaiph/blob/main/docs/jaiph-skill.md
    Follow that guide and Jaiph language rules exactly.
    Perform these tasks in order:
    1) Analyze repository structure, languages, package manager, and build/test/lint commands.
    2) Detect existing contribution conventions (branching, commit style, CI checks).
    3) Create or update Jaiph workflows under .jaiph/ for safe feature implementation, including:
       - preflight checks (clean git state, branch guards when relevant)
       - implementation workflow
       - verification workflow (tests/lint/build)
    4) Keep workflows minimal, composable, and specific to this project.
    5) Print a short usage guide with exact jaiph run commands.
  "
}
`;

function runInit(rest: string[]): number {
  const workspaceArg = rest[0] ?? ".";
  const workspaceRoot = resolve(workspaceArg);
  const stats = statSync(workspaceRoot);
  if (!stats.isDirectory()) {
    process.stderr.write(`jaiph init expects a directory path, got: ${workspaceArg}\n`);
    return 1;
  }

  const jaiphDir = join(workspaceRoot, ".jaiph");
  const bootstrapPath = join(jaiphDir, "bootstrap.jph");
  const palette = colorPalette();

  process.stdout.write("\n");
  process.stdout.write("Jaiph init\n");
  process.stdout.write("\n");
  process.stdout.write(`${palette.dim}▸ Creating ${join(".jaiph", "bootstrap.jph")} in ${workspaceRoot}...${palette.reset}\n`);
  mkdirSync(jaiphDir, { recursive: true });

  let createdBootstrap = false;
  if (!existsSync(bootstrapPath)) {
    writeFileSync(bootstrapPath, BOOTSTRAP_TEMPLATE, "utf8");
    createdBootstrap = true;
  }

  process.stdout.write(`${palette.green}✓ Initialized ${join(".jaiph", "bootstrap.jph")}${palette.reset}\n`);
  if (!createdBootstrap) {
    process.stdout.write(`${palette.dim}▸ Note: bootstrap file already existed; left unchanged.${palette.reset}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write("Try:\n");
  process.stdout.write("  jaiph run .jaiph/bootstrap.jph\n");
  process.stdout.write("\n");
  process.stdout.write("This asks an agent to analyze the project and scaffold recommended workflows.\n");
  process.stdout.write("Tip: add `.jaiph/runs/` and `.jaiph/cache/` to `.gitignore`.\n");
  process.stdout.write("\n");
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
  const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
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
      "set +e",
      '"$entrypoint" "$@"',
      "status=$?",
      "set -e",
      'echo "__JAIPH_META_STATUS__:${status}"',
      'echo "__JAIPH_META_RUN_DIR__:${JAIPH_RUN_DIR:-}"',
      'exit "$status"',
    ].join("\n");
    const startedAt = Date.now();
    const execResult = spawnSync(
      "bash",
      ["-c", command, "jaiph-run", builtPath, workflowSymbol, ...runArgs],
      {
        stdio: "pipe",
        encoding: "utf8",
        cwd: workspaceRoot,
        env: { ...process.env, JAIPH_WORKSPACE: workspaceRoot },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const stdoutMeta = extractRunMeta(execResult.stdout ?? "");
    const stderrMeta = extractRunMeta(execResult.stderr ?? "");
    const runDir = stdoutMeta.runDir ?? stderrMeta.runDir;
    const resolvedStatus =
      typeof execResult.status === "number" ? execResult.status : (stdoutMeta.status ?? stderrMeta.status ?? 1);

    if (stdoutMeta.output) {
      process.stdout.write(`${stdoutMeta.output}\n`);
    }

    const palette = colorPalette();
    if (resolvedStatus === 0) {
      if (stderrMeta.output) {
        process.stderr.write(`${stderrMeta.output}\n`);
      }
      process.stdout.write(
        `${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedMs}ms)${palette.reset}\n`,
      );
      return 0;
    }

    const summary = summarizeError(stderrMeta.output, execResult.error?.message);
    process.stderr.write(
      `${palette.red}\u2717 FAIL${palette.reset} workflow default ${palette.dim}(${elapsedMs}ms)${palette.reset}\n`,
    );
    process.stderr.write(`  ${summary}\n`);
    if (runDir) {
      const files = latestRunFiles(runDir);
      process.stderr.write(`  Logs: ${runDir}\n`);
      if (files.out) {
        process.stderr.write(`    out: ${files.out}\n`);
      }
      if (files.err) {
        process.stderr.write(`    err: ${files.err}\n`);
      }
    }

    return resolvedStatus;
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
    if (cmd === "init") {
      return runInit(rest);
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
