#!/usr/bin/env node
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { build, workflowSymbolForFile } from "./transpiler";
import { parsejaiph } from "./parser";
import { jaiphModule } from "./types";
import { loadJaiphConfig } from "./config";

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
  const functionNames = mod.functions.map((item) => item.name);
  const collectFunctionCalls = (command: string): string[] => {
    const hits: string[] = [];
    for (const fnName of functionNames) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])${fnName}(\\s|\\)|$)`);
      if (pattern.test(command)) {
        hits.push(fnName);
      }
    }
    return hits;
  };
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
    if (step.type === "shell") {
      for (const fnName of collectFunctionCalls(step.command)) {
        items.push({ label: `function ${fnName}` });
      }
    }
  }
  return items;
}

type TreeRow = {
  rawLabel: string;
  prefix: string;
  branch?: string;
  isRoot: boolean;
};

function buildRunTreeRows(mod: jaiphModule, rootLabel = "workflow default"): TreeRow[] {
  const rows: TreeRow[] = [{ rawLabel: rootLabel, prefix: "", isRoot: true }];
  const visited = new Set<string>(["default"]);
  const renderChildren = (workflowName: string, prefix: string): void => {
    const children = collectWorkflowChildren(mod, workflowName);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      rows.push({ rawLabel: child.label, prefix, branch, isRoot: false });
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
  return rows;
}

function parseLabel(rawLabel: string): { kind: string; name: string } {
  const firstSpace = rawLabel.indexOf(" ");
  if (firstSpace === -1) {
    return { kind: "step", name: rawLabel };
  }
  return {
    kind: rawLabel.slice(0, firstSpace),
    name: rawLabel.slice(firstSpace + 1),
  };
}

function parseStepMarker(line: string): { funcName: string; status: number; elapsedSec: number } | undefined {
  const prefix = "__JAIPH_STEP_END__|";
  if (!line.startsWith(prefix)) {
    return undefined;
  }
  const payload = line.slice(prefix.length).split("|");
  if (payload.length !== 3) {
    return undefined;
  }
  const status = Number.parseInt(payload[1], 10);
  const elapsedSec = Number.parseInt(payload[2], 10);
  if (Number.isNaN(status) || Number.isNaN(elapsedSec)) {
    return undefined;
  }
  return { funcName: payload[0], status, elapsedSec };
}

function parseFunctionRef(funcName: string): { kind: string; name: string } {
  if (funcName.includes("__workflow_")) {
    return { kind: "workflow", name: funcName.slice(funcName.lastIndexOf("__workflow_") + "__workflow_".length) };
  }
  if (funcName.includes("__rule_")) {
    return { kind: "rule", name: funcName.slice(funcName.lastIndexOf("__rule_") + "__rule_".length) };
  }
  if (funcName.includes("__function_")) {
    return { kind: "function", name: funcName.slice(funcName.lastIndexOf("__function_") + "__function_".length) };
  }
  if (funcName === "jaiph__prompt") {
    return { kind: "prompt", name: "prompt" };
  }
  return { kind: "step", name: funcName };
}

type RowState = { status: "pending" | "done" | "failed"; elapsedSec?: number };

function styleKeywordLabel(rawLabel: string): string {
  const { kind, name } = parseLabel(rawLabel);
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return `${kind} ${name}`;
  }
  return `\u001b[1m${kind}\u001b[0m ${name}`;
}

function styleDim(text: string): string {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return text;
  }
  return `\u001b[2m${text}\u001b[0m`;
}

function renderProgressTree(
  rows: TreeRow[],
  states: RowState[],
  rootElapsedSec?: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.isRoot) {
      const rootStatus = typeof rootElapsedSec === "number" ? ` ${styleDim(`(${rootElapsedSec}s)`)}` : "";
      lines.push(`${styleKeywordLabel(row.rawLabel)}${rootStatus}`);
      continue;
    }
    const state = states[i];
    const suffix =
      state.status === "pending"
        ? styleDim("(pending)")
        : state.status === "failed"
          ? styleDim(`(${state.elapsedSec ?? 0}s failed)`)
          : styleDim(`(${state.elapsedSec ?? 0}s)`);
    lines.push(`${row.prefix}${row.branch ?? ""}${styleKeywordLabel(row.rawLabel)} ${suffix}`);
  }
  return lines.join("\n");
}

function styleTreeLabel(label: string): string {
  return styleKeywordLabel(label);
}

function renderRunTree(mod: jaiphModule, rootLabel = "workflow default"): string {
  const lines = [styleTreeLabel(rootLabel)];
  const visited = new Set<string>(["default"]);

  const renderChildren = (workflowName: string, prefix: string): void => {
    const children = collectWorkflowChildren(mod, workflowName);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${branch}${styleTreeLabel(child.label)}`);
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
      "  jaiph run [--target <dir>] <file.jph> [args...]",
      "  jaiph init [workspace-path]",
      "  jaiph use <version|nightly>",
      "",
      "Examples:",
      "  jaiph build ./",
      "  jaiph build --target ./build ./",
      "  jaiph run ./flows/review.jph 'review this diff'",
      "  jaiph init",
      "  jaiph use nightly",
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
    process.stdout.write("no .jph files found\n");
  }
  return 0;
}

const BOOTSTRAP_TEMPLATE = `#!/usr/bin/env jaiph

# Bootstraps Jaiph workflows for this repository.
workflow default {
  prompt "
    You are bootstrapping Jaiph for this repository.
    First, read the Jaiph agent bootstrap guide at:
    .jaiph/jaiph-skill.md
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

const LOCAL_CONFIG_TEMPLATE = `# Jaiph project configuration
[agent]
# Default model for prompt steps (passed as --model to the agent command).
default_model = "gpt-5"

[run]
# Store run logs under .jaiph/runs by default (relative to workspace root).
logs_dir = ".jaiph/runs"
# Set to true to enable shell xtrace during jaiph run.
debug = false
`;

function resolveInstalledSkillPath(): string | undefined {
  if (process.env.JAIPH_SKILL_PATH && existsSync(process.env.JAIPH_SKILL_PATH)) {
    return process.env.JAIPH_SKILL_PATH;
  }
  const candidates = [
    join(__dirname, "..", "jaiph-skill.md"),
    join(__dirname, "..", "..", "docs", "jaiph-skill.md"),
    join(process.cwd(), "docs", "jaiph-skill.md"),
  ];
  return candidates.find((path) => existsSync(path));
}

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
  const configPath = join(jaiphDir, "config.toml");
  const skillPath = join(jaiphDir, "jaiph-skill.md");
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
  chmodSync(bootstrapPath, 0o755);
  let createdConfig = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, LOCAL_CONFIG_TEMPLATE, "utf8");
    createdConfig = true;
  }
  const installedSkillPath = resolveInstalledSkillPath();
  let syncedSkill = false;
  if (installedSkillPath) {
    writeFileSync(skillPath, readFileSync(installedSkillPath, "utf8"), "utf8");
    syncedSkill = true;
  }

  process.stdout.write(`${palette.green}✓ Initialized ${join(".jaiph", "bootstrap.jph")}${palette.reset}\n`);
  if (!createdBootstrap) {
    process.stdout.write(`${palette.dim}▸ Note: bootstrap file already existed; left unchanged.${palette.reset}\n`);
  }
  if (createdConfig) {
    process.stdout.write(`${palette.green}✓ Initialized ${join(".jaiph", "config.toml")}${palette.reset}\n`);
  } else {
    process.stdout.write(`${palette.dim}▸ Note: config file already existed; left unchanged.${palette.reset}\n`);
  }
  if (syncedSkill) {
    process.stdout.write(`${palette.green}✓ Synced ${join(".jaiph", "jaiph-skill.md")}${palette.reset}\n`);
  } else {
    process.stdout.write(`${palette.dim}▸ Note: local jaiph-skill.md not found in installation; skipped sync.${palette.reset}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write("Try:\n");
  process.stdout.write("  ./.jaiph/bootstrap.jph\n");
  process.stdout.write("\n");
  process.stdout.write("This asks an agent to analyze the project and scaffold recommended workflows.\n");
  process.stdout.write("Tip: add `.jaiph/runs/` to `.gitignore`.\n");
  process.stdout.write("\n");
  return 0;
}

async function runWorkflow(rest: string[]): Promise<number> {
  const { target, positional } = parseArgs(rest);
  const input = positional[0];
  const runArgs = positional.slice(1);
  if (!input) {
    process.stderr.write("jaiph run requires a .jph file path\n");
    return 1;
  }
  const inputAbs = resolve(input);
  const workspaceRoot = detectWorkspaceRoot(dirname(inputAbs));
  const config = loadJaiphConfig(workspaceRoot);
  const inputStat = statSync(inputAbs);
  if (!inputStat.isFile() || extname(inputAbs) !== ".jph") {
    process.stderr.write("jaiph run expects a single .jph file\n");
    return 1;
  }

  const outDir = target ? resolve(target) : mkdtempSync(join(tmpdir(), "jaiph-run-"));
  const shouldCleanup = !target;
  try {
    const mod = parsejaiph(readFileSync(inputAbs, "utf8"), inputAbs);
    const treeRows = buildRunTreeRows(mod);
    const rowStates: RowState[] = treeRows.map((row) => (row.isRoot ? { status: "done" } : { status: "pending" }));
    process.stdout.write(`${renderProgressTree(treeRows, rowStates)}\n`);

    const results = build(inputAbs, outDir);
    if (results.length !== 1) {
      process.stderr.write(`jaiph run expected one built output, got ${results.length}\n`);
      return 1;
    }
    const builtPath = results[0].outputPath;
    const workflowSymbol = workflowSymbolForFile(inputAbs, dirname(inputAbs));
    const command = [
      'meta_file="$1"; shift',
      'built_script="$1"; shift',
      'workflow_symbol="$1"; shift',
      'source "$built_script"',
      'entrypoint="${workflow_symbol}__workflow_default"',
      'if ! declare -F "$entrypoint" >/dev/null; then',
      '  echo "jaiph run requires workflow \'default\' in the input file" >&2',
      "  exit 1",
      "fi",
      'if [[ "${JAIPH_DEBUG:-}" == "true" ]]; then',
      "  set -x",
      "fi",
      "set +e",
      '"$entrypoint" "$@"',
      "status=$?",
      "set -e",
      'if [[ -n "${meta_file:-}" ]]; then',
      '  printf "status=%s\\n" "$status" > "$meta_file"',
      '  printf "run_dir=%s\\n" "${JAIPH_RUN_DIR:-}" >> "$meta_file"',
      "fi",
      'exit "$status"',
    ].join("\n");
    const startedAt = Date.now();
    const runtimeEnv = { ...process.env, JAIPH_WORKSPACE: workspaceRoot } as Record<string, string | undefined>;
    if (runtimeEnv.JAIPH_AGENT_MODEL === undefined && config.agent?.defaultModel) {
      runtimeEnv.JAIPH_AGENT_MODEL = config.agent.defaultModel;
    }
    if (runtimeEnv.JAIPH_AGENT_COMMAND === undefined && config.agent?.command) {
      runtimeEnv.JAIPH_AGENT_COMMAND = config.agent.command;
    }
    if (runtimeEnv.JAIPH_RUNS_DIR === undefined && config.run?.logsDir) {
      runtimeEnv.JAIPH_RUNS_DIR = config.run.logsDir;
    }
    if (runtimeEnv.JAIPH_DEBUG === undefined && config.run?.debug === true) {
      runtimeEnv.JAIPH_DEBUG = "true";
    }
    if (runtimeEnv.JAIPH_STDLIB === undefined) {
      runtimeEnv.JAIPH_STDLIB = join(__dirname, "jaiph_stdlib.sh");
    }
    const metaFile = join(outDir, `.jaiph-run-meta-${Date.now()}-${process.pid}.txt`);
    const execResult = spawn(
      "bash",
      ["-c", command, "jaiph-run", metaFile, builtPath, workflowSymbol, ...runArgs],
      {
        stdio: "pipe",
        cwd: workspaceRoot,
        env: runtimeEnv,
      },
    );
    let capturedStderr = "";
    let stderrBuffer = "";
    let counterVisible = false;
    const clearCounter = (): void => {
      if (!counterVisible || !process.stderr.isTTY) {
        return;
      }
      process.stderr.write("\r\x1b[2K");
      counterVisible = false;
    };
    const renderCounter = (): void => {
      if (!process.stderr.isTTY) {
        return;
      }
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      process.stderr.write(`\r${colorPalette().dim}… running ${seconds}s${colorPalette().reset}`);
      counterVisible = true;
    };
    const applyStepUpdate = (funcName: string, status: number, elapsedSec: number): void => {
      const parsed = parseFunctionRef(funcName);
      if (parsed.kind === "workflow" && parsed.name === "default") {
        return;
      }
      let changed = false;
      for (let i = 1; i < treeRows.length; i += 1) {
        const label = parseLabel(treeRows[i].rawLabel);
        const nameMatches = label.name === parsed.name || label.name.endsWith(`.${parsed.name}`);
        if (label.kind === parsed.kind && nameMatches && rowStates[i].status === "pending") {
          rowStates[i] = { status: status === 0 ? "done" : "failed", elapsedSec };
          changed = true;
          break;
        }
      }
      if (changed) {
        process.stdout.write(`${renderProgressTree(treeRows, rowStates)}\n`);
      }
    };
    const handleStderrLine = (line: string): void => {
      const marker = parseStepMarker(line);
      if (marker) {
        applyStepUpdate(marker.funcName, marker.status, marker.elapsedSec);
        return;
      }
      if (line.length > 0) {
        capturedStderr += `${line}\n`;
        process.stderr.write(`${line}\n`);
      }
    };
    const counterTimer = setInterval(renderCounter, 1000);
    execResult.stdout?.setEncoding("utf8");
    execResult.stderr?.setEncoding("utf8");
    execResult.stdout?.on("data", (chunk: string) => {
      clearCounter();
      process.stdout.write(chunk);
    });
    execResult.stderr?.on("data", (chunk: string) => {
      clearCounter();
      stderrBuffer += chunk;
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        handleStderrLine(line);
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });
    const childExit = await new Promise<{ status: number; signal: NodeJS.Signals | null }>((resolveExit) => {
      execResult.on("close", (code, signal) => {
        resolveExit({ status: typeof code === "number" ? code : 1, signal });
      });
    });
    clearInterval(counterTimer);
    clearCounter();
    if (stderrBuffer.length > 0) {
      handleStderrLine(stderrBuffer.replace(/\r$/, ""));
      stderrBuffer = "";
    }
    if (childExit.signal && capturedStderr.trim().length === 0) {
      capturedStderr = `Process terminated by signal ${childExit.signal}`;
    }
    const elapsedMs = Date.now() - startedAt;
    let runDir: string | undefined;
    if (existsSync(metaFile)) {
      const metaLines = readFileSync(metaFile, "utf8").split(/\r?\n/);
      for (const line of metaLines) {
        if (line.startsWith("run_dir=")) {
          const value = line.slice("run_dir=".length).trim();
          if (value) {
            runDir = value;
          }
        }
      }
    }
    const resolvedStatus = childExit.status;

    process.stdout.write(`${renderProgressTree(treeRows, rowStates, Math.floor(elapsedMs / 1000))}\n`);

    const palette = colorPalette();
    if (resolvedStatus === 0) {
      process.stdout.write(
        `${palette.green}\u2713 PASS${palette.reset} workflow default ${palette.dim}(${elapsedMs}ms)${palette.reset}\n`,
      );
      return 0;
    }

    const summary = summarizeError(capturedStderr, "Workflow execution failed.");
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

function toInstallRef(version: string): string | undefined {
  const trimmed = version.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "nightly") {
    return "main";
  }
  return `v${trimmed}`;
}

function runUse(rest: string[]): number {
  const version = rest[0];
  if (!version) {
    process.stderr.write("jaiph use requires a version (e.g. 0.1.0) or 'nightly'\n");
    return 1;
  }
  const ref = toInstallRef(version);
  if (!ref) {
    process.stderr.write("jaiph use requires a non-empty version or 'nightly'\n");
    return 1;
  }
  const installCommand = process.env.JAIPH_INSTALL_COMMAND ?? "curl -fsSL https://jaiph.org/install | bash";
  process.stdout.write(`Reinstalling Jaiph from ref '${ref}'...\n`);
  const result = spawnSync("bash", ["-c", installCommand], {
    stdio: "inherit",
    env: { ...process.env, JAIPH_REPO_REF: ref },
  });
  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("jaiph 0.0.1\n");
    return 0;
  }
  try {
    if (cmd.endsWith(".jph") && existsSync(resolve(cmd))) {
      return runWorkflow([cmd, ...rest]);
    }
    if (cmd === "build") {
      return runBuild(rest);
    }
    if (cmd === "run") {
      return runWorkflow(rest);
    }
    if (cmd === "init") {
      return runInit(rest);
    }
    if (cmd === "use") {
      return runUse(rest);
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

main(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
