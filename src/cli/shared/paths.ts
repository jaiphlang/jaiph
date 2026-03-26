import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parsejaiph } from "../../parser";
import { resolveImportPath } from "../../transpiler";
import { jaiphModule } from "../../types";

/**
 * When TMPDIR (or other tooling) places temp projects under `<repo>/.jaiph/tmp/...`,
 * walking up to the outer repo would treat the whole monorepo as the Jaiph workspace.
 * Skip markers for ancestors whose `.jaiph/tmp` contains `startDir`.
 */
function startDirIsUnderAncestorJaiphTmp(absStartDir: string, candidateRoot: string): boolean {
  const jaiphTmp = resolve(join(candidateRoot, ".jaiph", "tmp"));
  const start = resolve(absStartDir);
  return start === jaiphTmp || start.startsWith(jaiphTmp + sep);
}

/**
 * `/tmp` (and similar) often contains stray `.git` / `.jaiph` markers. Treating that directory as the
 * workspace makes `build()` walk the entire temp tree and pick up unrelated `.jh` files.
 */
function skipWorkspaceMarkerOnSharedTmpRoot(candidateRoot: string, absStartDir: string): boolean {
  // macOS often uses `/private/tmp` as the canonical path while `/tmp` is a symlink; `dirname` walks
  // yield `/private/tmp`, which must be treated like `/tmp` so we never use the whole shared temp tree
  // as the Jaiph workspace when a stray `.git` / `.jaiph` exists there.
  const sharedRoots = [resolve("/tmp"), resolve("/private/tmp"), resolve("/var/tmp")];
  const c = resolve(candidateRoot);
  const s = resolve(absStartDir);
  if (!sharedRoots.includes(c)) {
    return false;
  }
  if (s === c) {
    return false;
  }
  const prefix = c.endsWith(sep) ? c : c + sep;
  return s.startsWith(prefix);
}

export function detectWorkspaceRoot(startDir: string): string {
  const fallback = resolve(startDir);
  let current = fallback;
  while (true) {
    if (existsSync(join(current, ".jaiph")) || existsSync(join(current, ".git"))) {
      if (
        !startDirIsUnderAncestorJaiphTmp(fallback, current) &&
        !skipWorkspaceMarkerOnSharedTmpRoot(current, fallback)
      ) {
        return current;
      }
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
