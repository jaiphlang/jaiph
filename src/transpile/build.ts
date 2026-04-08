import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, parse, relative, resolve } from "node:path";
import { parsejaiph } from "../parser";
import type { ScriptArtifact } from "./emit-script";
import { JAIPH_EXT_REGEX, resolveImportPath } from "./resolve";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function walkjhFiles(inputPath: string): string[] {
  const s = statSync(inputPath);
  if (s.isFile()) {
    const ext = extname(inputPath);
    if (ext !== ".jh") return [];
    const base = parse(inputPath).name;
    if (base.endsWith(".test")) return [];
    return [inputPath];
  }

  const files: string[] = [];
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        const base = parse(entry.name).name;
        if (ext === ".jh" && !base.endsWith(".test")) {
          files.push(full);
        }
      }
    }
  }
  files.sort();
  return files;
}

export function walkTestFiles(inputPath: string): string[] {
  const s = statSync(inputPath);
  if (s.isFile()) {
    const ext = extname(inputPath);
    const base = parse(inputPath).name;
    if (ext === ".jh" && base.endsWith(".test")) {
      return [inputPath];
    }
    return [];
  }
  const files: string[] = [];
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        const base = parse(entry.name).name;
        if (ext === ".jh" && base.endsWith(".test")) {
          files.push(full);
        }
      }
    }
  }
  files.sort();
  return files;
}

function collectFileWithImports(entrypoint: string, workspaceRoot?: string): string[] {
  const visited = new Set<string>();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const ast = parsejaiph(readFileSync(file, "utf8"), file);
    for (const imp of ast.imports) {
      const importedFile = resolveImportPath(file, imp.path, workspaceRoot);
      if (!visited.has(importedFile)) queue.push(importedFile);
    }
  }
  const files = [...visited];
  files.sort();
  return files;
}

/**
 * Writes extracted `script` bodies to `<targetDir>/scripts`.
 */
export function buildScripts(
  inputPath: string,
  targetDir: string | undefined,
  emitScriptsFn: (file: string, root: string) => ScriptArtifact[],
  workspaceRoot?: string,
): { scriptsDir: string } {
  const absInput = resolve(inputPath);
  const inputStat = statSync(absInput);
  const rootDir = inputStat.isDirectory() ? absInput : dirname(absInput);
  const outRoot = resolve(targetDir ?? rootDir);
  ensureDir(outRoot);

  const entrypointFile = inputStat.isFile() ? absInput : null;
  const files = entrypointFile ? collectFileWithImports(entrypointFile, workspaceRoot) : walkjhFiles(rootDir);
  const scriptsRoot = join(outRoot, "scripts");
  ensureDir(scriptsRoot);

  for (const file of files) {
    const scripts = emitScriptsFn(file, rootDir);
    for (const s of scripts) {
      const scriptPath = join(scriptsRoot, s.name);
      writeFileSync(scriptPath, s.content, "utf8");
      chmodSync(scriptPath, 0o755);
    }
  }

  return { scriptsDir: scriptsRoot };
}
