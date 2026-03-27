import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, parse, relative, resolve } from "node:path";
import { parsejaiph } from "../parser";
import type { CompileResult } from "../types";
import type { EmittedModule } from "./emit-workflow";
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

function collectFileWithImports(entrypoint: string): string[] {
  const visited = new Set<string>();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const ast = parsejaiph(readFileSync(file, "utf8"), file);
    for (const imp of ast.imports) {
      const importedFile = resolveImportPath(file, imp.path);
      if (!visited.has(importedFile)) queue.push(importedFile);
    }
  }
  const files = [...visited];
  files.sort();
  return files;
}

/**
 * Directory walking and output writes. Receives transpileFile from the caller
 * to avoid circular dependency with the main transpiler.
 */
export function build(
  inputPath: string,
  targetDir: string | undefined,
  transpileFileFn: (file: string, root: string) => EmittedModule,
): CompileResult[] {
  const absInput = resolve(inputPath);
  const inputStat = statSync(absInput);
  const rootDir = inputStat.isDirectory() ? absInput : dirname(absInput);
  const outRoot = resolve(targetDir ?? rootDir);
  ensureDir(outRoot);

  const entrypointFile = inputStat.isFile() ? absInput : null;
  const files = entrypointFile ? collectFileWithImports(entrypointFile) : walkjhFiles(rootDir);
  const results: CompileResult[] = [];
  for (const file of files) {
    const { module, scripts, sourceLineMap } = transpileFileFn(file, rootDir);
    const rel = relative(rootDir, file).replace(JAIPH_EXT_REGEX, ".sh");
    const outPath = join(outRoot, rel);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, module, "utf8");
    chmodSync(outPath, 0o755);
    if (sourceLineMap && sourceLineMap.length > 0) {
      const mapPath = join(dirname(outPath), `${basename(outPath, ".sh")}.jaiph.map`);
      writeFileSync(
        mapPath,
        `${JSON.stringify(
          { version: 1, shFile: outPath, mappings: sourceLineMap },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    const scriptsRoot = join(outRoot, "scripts");
    ensureDir(scriptsRoot);
    for (const s of scripts) {
      const scriptPath = join(scriptsRoot, s.name);
      writeFileSync(scriptPath, s.content, "utf8");
      chmodSync(scriptPath, 0o755);
    }
    if (entrypointFile === null || file === entrypointFile) {
      results.push({ outputPath: outPath, bash: module });
    }
  }

  return results;
}
