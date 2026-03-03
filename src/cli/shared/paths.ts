import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parsejaiph } from "../../parser";
import { resolveImportPath } from "../../transpiler";
import { jaiphModule } from "../../types";

export function detectWorkspaceRoot(startDir: string): string {
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

export function resolveInstalledSkillPath(): string | undefined {
  if (process.env.JAIPH_SKILL_PATH && existsSync(process.env.JAIPH_SKILL_PATH)) {
    return process.env.JAIPH_SKILL_PATH;
  }
  const candidates = [
    join(__dirname, "..", "..", "..", "jaiph-skill.md"),
    join(__dirname, "..", "..", "..", "..", "docs", "jaiph-skill.md"),
    join(process.cwd(), "docs", "jaiph-skill.md"),
  ];
  return candidates.find((path) => existsSync(path));
}

export function loadImportedModules(mainMod: jaiphModule): Map<string, jaiphModule> {
  const map = new Map<string, jaiphModule>();
  for (const imp of mainMod.imports) {
    const resolved = resolveImportPath(mainMod.filePath, imp.path);
    if (existsSync(resolved)) {
      map.set(imp.alias, parsejaiph(readFileSync(resolved, "utf8"), resolved));
    }
  }
  return map;
}
