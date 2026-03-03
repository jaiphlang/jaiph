import { existsSync } from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";

export const JAIPH_EXT_REGEX = /\.(jh|jph)$/;

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

export function resolveImportPath(fromFile: string, importPath: string): string {
  const dir = dirname(fromFile);
  if (importPath.endsWith(".jph") || importPath.endsWith(".jh")) {
    return resolve(dir, importPath);
  }
  const withJh = resolve(dir, `${importPath}.jh`);
  const withJph = resolve(dir, `${importPath}.jph`);
  if (existsSync(withJh)) {
    return withJh;
  }
  if (existsSync(withJph)) {
    return withJph;
  }
  return withJph;
}
