import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { colorPalette } from "../shared/errors";
import { resolveInstalledSkillPath } from "../shared/paths";

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

export function runInit(rest: string[]): number {
  const workspaceArg = rest[0] ?? ".";
  const workspaceRoot = resolve(workspaceArg);
  const stats = statSync(workspaceRoot);
  if (!stats.isDirectory()) {
    process.stderr.write(`jaiph init expects a directory path, got: ${workspaceArg}\n`);
    return 1;
  }

  const jaiphDir = join(workspaceRoot, ".jaiph");
  const bootstrapPath = join(jaiphDir, "bootstrap.jh");
  const skillPath = join(jaiphDir, "jaiph-skill.md");
  const palette = colorPalette();

  process.stdout.write("\n");
  process.stdout.write("Jaiph init\n");
  process.stdout.write("\n");
  process.stdout.write(`${palette.dim}▸ Creating ${join(".jaiph", "bootstrap.jh")} in ${workspaceRoot}...${palette.reset}\n`);
  mkdirSync(jaiphDir, { recursive: true });

  let createdBootstrap = false;
  if (!existsSync(bootstrapPath)) {
    writeFileSync(bootstrapPath, BOOTSTRAP_TEMPLATE, "utf8");
    createdBootstrap = true;
  }
  chmodSync(bootstrapPath, 0o755);
  const installedSkillPath = resolveInstalledSkillPath();
  let syncedSkill = false;
  if (installedSkillPath) {
    writeFileSync(skillPath, readFileSync(installedSkillPath, "utf8"), "utf8");
    syncedSkill = true;
  }

  process.stdout.write(`${palette.green}✓ Initialized ${join(".jaiph", "bootstrap.jh")}${palette.reset}\n`);
  if (!createdBootstrap) {
    process.stdout.write(`${palette.dim}▸ Note: bootstrap file already existed; left unchanged.${palette.reset}\n`);
  }
  if (syncedSkill) {
    process.stdout.write(`${palette.green}✓ Synced ${join(".jaiph", "jaiph-skill.md")}${palette.reset}\n`);
  } else {
    process.stdout.write(`${palette.dim}▸ Note: local jaiph-skill.md not found in installation; skipped sync.${palette.reset}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write("Try:\n");
  process.stdout.write("  ./.jaiph/bootstrap.jh\n");
  process.stdout.write("\n");
  process.stdout.write("This asks an agent to analyze the project and scaffold recommended workflows.\n");
  process.stdout.write("Tip: add `.jaiph/` to `.gitignore`.\n");
  process.stdout.write("\n");
  return 0;
}
