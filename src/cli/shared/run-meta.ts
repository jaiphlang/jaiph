import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remapContainerPath } from "./errors";

/**
 * Read selected `key=value` fields from a runner meta file. Returns an empty
 * object when the file is absent/unwritten; only non-empty values are included.
 */
export function readMetaFields(metaFile: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(metaFile)) return out;
  for (const line of readFileSync(metaFile, "utf8").split(/\r?\n/)) {
    for (const key of keys) {
      const prefix = `${key}=`;
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        if (value) out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Read a run's `return_value.txt`. In Docker mode `runDir` is discovered from
 * the host-side sandbox runs mount, so `remapContainerPath` normalizes any
 * container-internal prefix to the host path before reading.
 */
export function readReturnValue(
  runDir: string | undefined,
  sandboxRunDir: string | undefined,
): string | undefined {
  if (!runDir) return undefined;
  const candidate = sandboxRunDir
    ? remapContainerPath(join(runDir, "return_value.txt"), sandboxRunDir)
    : join(runDir, "return_value.txt");
  if (!existsSync(candidate)) return undefined;
  try {
    return readFileSync(candidate, "utf8");
  } catch {
    return undefined;
  }
}
