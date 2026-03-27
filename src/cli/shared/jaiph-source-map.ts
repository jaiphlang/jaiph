import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type JaiphSourceMapFile = {
  version: number;
  shFile: string;
  mappings: Array<{ bashLine: number; source: string; line: number; col: number }>;
};

export function jaiphMapPathForShFile(shPath: string): string {
  return join(dirname(shPath), `${basename(shPath, ".sh")}.jaiph.map`);
}

export function loadJaiphSourceMap(mapPath: string): JaiphSourceMapFile | null {
  if (!existsSync(mapPath)) {
    return null;
  }
  try {
    const raw = readFileSync(mapPath, "utf8");
    const parsed = JSON.parse(raw) as JaiphSourceMapFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Map a 1-based line in the generated `.sh` to the nearest recorded `.jh` step start at or above that line.
 */
export function bashLineToJaiphSource(
  map: JaiphSourceMapFile,
  bashLine: number,
): { source: string; line: number; col: number } | null {
  const sorted = [...map.mappings].sort((a, b) => a.bashLine - b.bashLine);
  let best: (typeof sorted)[0] | null = null;
  for (const m of sorted) {
    if (m.bashLine <= bashLine) {
      best = m;
    } else {
      break;
    }
  }
  if (!best) {
    return null;
  }
  return { source: best.source, line: best.line, col: best.col };
}

export type SourceMapCache = Map<string, JaiphSourceMapFile | null | undefined>;

function getCachedMap(shPath: string, cache: SourceMapCache): JaiphSourceMapFile | null {
  if (cache.has(shPath)) {
    const hit = cache.get(shPath);
    return hit === undefined ? null : hit;
  }
  const loaded = loadJaiphSourceMap(jaiphMapPathForShFile(shPath));
  cache.set(shPath, loaded);
  return loaded;
}

/**
 * Rewrite bash error fragments `path/file.sh:LINE` or `path/file.sh: line LINE:` using `.jaiph.map` when present.
 */
export function rewriteJaiphDiagnosticsLine(line: string, cache: SourceMapCache): string {
  return line.replace(
    /([^\s"'<>|]+\.sh)(?::\s*line\s+|:)(\d+)(?=:|\b)/gi,
    (full, shPath: string, lineStr: string) => {
      const n = parseInt(lineStr, 10);
      if (Number.isNaN(n)) {
        return full;
      }
      const map = getCachedMap(shPath, cache);
      if (!map) {
        return full;
      }
      const src = bashLineToJaiphSource(map, n);
      if (!src) {
        return full;
      }
      return `${src.source}:${src.line}:${src.col} (bash ${shPath}:${n})`;
    },
  );
}
