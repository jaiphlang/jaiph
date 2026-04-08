import { existsSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

export const JAIPH_EXT_REGEX = /\.jh$/;

function toWorkflowSymbol(inputFile: string, rootDir: string): string {
  const rel = relative(rootDir, inputFile);
  const parsed = parse(rel);
  const dirParts = parsed.dir ? parsed.dir.split(sep).filter(Boolean) : [];
  return [...dirParts, parsed.name].join("::");
}

export function workflowSymbolForFile(inputFile: string, rootDir: string): string {
  return toWorkflowSymbol(resolve(inputFile), resolve(rootDir));
}

export function toImportSource(importPath: string, inputFile: string, rootDir: string): string {
  const importedFile = resolveImportPath(inputFile, importPath);
  const importedRel = relative(rootDir, importedFile).replace(JAIPH_EXT_REGEX, ".sh");
  const currentRel = relative(rootDir, inputFile).replace(JAIPH_EXT_REGEX, ".sh");
  const currentDir = dirname(currentRel);
  return relative(currentDir, importedRel).split(sep).join("/");
}

export function resolveImportPath(fromFile: string, importPath: string, workspaceRoot?: string): string {
  const dir = dirname(fromFile);
  const relativePath = importPath.endsWith(".jh")
    ? resolve(dir, importPath)
    : resolve(dir, `${importPath}.jh`);

  // If relative resolution finds a file, use it (existing behavior).
  if (existsSync(relativePath)) {
    return relativePath;
  }

  // Lib fallback: paths with "/" that don't resolve relatively are split as
  // <lib-name>/<path-inside-lib> and resolved to <workspace>/.jaiph/libs/<lib>/<path>.jh
  if (workspaceRoot && importPath.includes("/")) {
    const slashIdx = importPath.indexOf("/");
    const libName = importPath.slice(0, slashIdx);
    const rest = importPath.slice(slashIdx + 1);
    const libPath = rest.endsWith(".jh")
      ? join(workspaceRoot, ".jaiph", "libs", libName, rest)
      : join(workspaceRoot, ".jaiph", "libs", libName, `${rest}.jh`);
    if (existsSync(libPath)) {
      return libPath;
    }
  }

  // Return the relative path even if it doesn't exist — the validator will emit E_IMPORT_NOT_FOUND.
  return relativePath;
}
