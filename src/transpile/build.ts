import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, parse, relative, resolve } from "node:path";
import { emitScriptsForModuleFromGraph } from "./emit-from-graph";
import type { ModuleGraph } from "./module-graph";
import { loadModuleGraph } from "./module-graph";
import { JAIPH_EXT_REGEX } from "./resolve";

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
  const rootDir = resolve(inputPath);
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipJhWalkDirectory(rootDir, full)) continue;
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

function shouldSkipJhWalkDirectory(rootDir: string, directory: string): boolean {
  const rel = relative(rootDir, directory).split("/").join("/");
  const rootBase = parse(rootDir).base;
  if (rootBase === ".jaiph" && (
    rel === "runs" ||
    rel === "tmp" ||
    rel === "artifacts" ||
    rel === ".tmp-build-out"
  )) {
    return true;
  }
  return (
    rel === ".jaiph/runs" ||
    rel.startsWith(".jaiph/runs/") ||
    rel === ".jaiph/tmp" ||
    rel.startsWith(".jaiph/tmp/") ||
    rel === ".jaiph/artifacts" ||
    rel.startsWith(".jaiph/artifacts/") ||
    rel === ".jaiph/.tmp-build-out" ||
    rel.startsWith(".jaiph/.tmp-build-out/")
  );
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

/**
 * Path-based entry point. Loads a `ModuleGraph` and writes extracted `script`
 * bodies under `<targetDir>/scripts`. For a directory input, every non-test
 * `.jh` becomes its own root: each rooted graph is loaded and emitted. The
 * directory walk preserves the historical multi-entry validation semantics
 * for `jaiph compile <dir>` and the integration test corpus.
 */
export function buildScripts(
  inputPath: string,
  targetDir: string | undefined,
  workspaceRoot?: string,
): { scriptsDir: string } {
  const absInput = resolve(inputPath);
  const inputStat = statSync(absInput);
  const rootDir = inputStat.isDirectory() ? absInput : dirname(absInput);
  const outRoot = resolve(targetDir ?? rootDir);
  ensureDir(outRoot);
  const scriptsRoot = join(outRoot, "scripts");
  ensureDir(scriptsRoot);

  if (inputStat.isFile()) {
    const graph = loadModuleGraph(absInput, workspaceRoot);
    emitGraphInto(graph, rootDir, scriptsRoot);
    return { scriptsDir: scriptsRoot };
  }

  for (const entry of walkjhFiles(absInput)) {
    const graph = loadModuleGraph(entry, workspaceRoot);
    emitGraphInto(graph, rootDir, scriptsRoot);
  }
  return { scriptsDir: scriptsRoot };
}

/**
 * Graph-based entry point. The caller has already built a `ModuleGraph` (the
 * default `jaiph run` path); emit every reachable module's scripts into
 * `<targetDir>/scripts` without re-parsing anything. `rootDir` defaults to
 * the entry's parent directory so symbol prefixes match the path-based form.
 */
export function buildScriptsFromGraph(
  graph: ModuleGraph,
  targetDir: string,
  rootDir?: string,
): { scriptsDir: string } {
  const outRoot = resolve(targetDir);
  ensureDir(outRoot);
  const scriptsRoot = join(outRoot, "scripts");
  ensureDir(scriptsRoot);
  const resolvedRoot = resolve(rootDir ?? dirname(graph.entryFile));
  emitGraphInto(graph, resolvedRoot, scriptsRoot);
  return { scriptsDir: scriptsRoot };
}

function emitGraphInto(graph: ModuleGraph, rootDir: string, scriptsRoot: string): void {
  const files = [...graph.modules.keys()].sort();
  for (const file of files) {
    const scripts = emitScriptsForModuleFromGraph(graph, file, rootDir);
    for (const s of scripts) {
      const scriptPath = join(scriptsRoot, s.name);
      writeFileSync(scriptPath, s.content, "utf8");
      chmodSync(scriptPath, 0o755);
    }
  }
}

// Re-export so `jaiph compile` can use the centralized regex.
export { JAIPH_EXT_REGEX };
