import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, parse, relative, resolve } from "node:path";
import type { CompileResult } from "../types";
import { JAIPH_EXT_REGEX } from "./resolve";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function walkjhFiles(inputPath: string): string[] {
  const s = statSync(inputPath);
  if (s.isFile()) {
    const ext = extname(inputPath);
    if (ext !== ".jph" && ext !== ".jh") return [];
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
        if ((ext === ".jph" || ext === ".jh") && !base.endsWith(".test")) {
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
    if ((ext === ".jh" || ext === ".jph") && base.endsWith(".test")) {
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
        if ((ext === ".jh" || ext === ".jph") && base.endsWith(".test")) {
          files.push(full);
        }
      }
    }
  }
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
  transpileFileFn: (file: string, root: string) => string,
): CompileResult[] {
  const absInput = resolve(inputPath);
  const inputStat = statSync(absInput);
  const rootDir = inputStat.isDirectory() ? absInput : dirname(absInput);
  const outRoot = resolve(targetDir ?? rootDir);
  ensureDir(outRoot);

  const files = walkjhFiles(rootDir);
  const entrypointFile = inputStat.isFile() ? absInput : null;
  const results: CompileResult[] = [];
  for (const file of files) {
    const bash = transpileFileFn(file, rootDir);
    const rel = relative(rootDir, file).replace(JAIPH_EXT_REGEX, ".sh");
    const outPath = join(outRoot, rel);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, bash, "utf8");
    if (entrypointFile === null || file === entrypointFile) {
      results.push({ outputPath: outPath, bash });
    }
  }

  return results;
}
