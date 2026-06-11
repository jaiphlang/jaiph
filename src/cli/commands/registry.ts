import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_REGISTRY_URL = "https://jaiph.org/registry";

export const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

const NAME_ARG_REGEX = /^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/;

export interface RegistryEntry {
  url: string;
  description: string;
}

export interface RegistryIndex {
  libs: Record<string, RegistryEntry>;
}

/** True for `name` or `name@version` (single segment — no `/`, no `:`). */
export function isRegistryNameArg(arg: string): boolean {
  if (arg.includes("/") || arg.includes(":")) return false;
  return NAME_ARG_REGEX.test(arg);
}

export function parseNameArg(arg: string): { name: string; version?: string } {
  const at = arg.indexOf("@");
  if (at > 0) {
    return { name: arg.slice(0, at), version: arg.slice(at + 1) };
  }
  return { name: arg };
}

/** Pick the registry source: env override wins, else the default URL. */
export function registrySource(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAIPH_REGISTRY;
  if (override && override.length > 0) return override;
  return DEFAULT_REGISTRY_URL;
}

/**
 * Load and validate the registry index from `source`. `file://` URLs and any
 * value without a `://` scheme are read from disk; everything else is fetched
 * via global `fetch`. Throws `Error` with the source in the message on any
 * read/parse/shape failure.
 */
export async function loadRegistryIndex(source: string): Promise<RegistryIndex> {
  const text = await readRegistrySource(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`failed to parse registry ${source}: ${(err as Error).message}`);
  }
  return validateRegistryIndex(parsed, source);
}

async function readRegistrySource(source: string): Promise<string> {
  if (source.startsWith("file://")) {
    const path = fileURLToPath(source);
    return readDisk(path, source);
  }
  if (!source.includes("://")) {
    return readDisk(source, source);
  }
  let res: Response;
  try {
    res = await fetch(source);
  } catch (err) {
    throw new Error(`failed to fetch registry ${source}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`failed to fetch registry ${source}: HTTP ${res.status}`);
  }
  try {
    return await res.text();
  } catch (err) {
    throw new Error(`failed to fetch registry ${source}: ${(err as Error).message}`);
  }
}

function readDisk(path: string, source: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`failed to read registry ${source}: ${(err as Error).message}`);
  }
}

function validateRegistryIndex(parsed: unknown, source: string): RegistryIndex {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`failed to parse registry ${source}: top-level must be an object`);
  }
  const libs = (parsed as { libs?: unknown }).libs;
  if (typeof libs !== "object" || libs === null || Array.isArray(libs)) {
    throw new Error(`failed to parse registry ${source}: "libs" must be an object`);
  }
  const out: Record<string, RegistryEntry> = {};
  for (const [name, raw] of Object.entries(libs)) {
    if (!REGISTRY_NAME_REGEX.test(name)) {
      throw new Error(`failed to parse registry ${source}: invalid name "${name}"`);
    }
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`failed to parse registry ${source}: entry "${name}" must be an object`);
    }
    const url = (raw as { url?: unknown }).url;
    const description = (raw as { description?: unknown }).description;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`failed to parse registry ${source}: entry "${name}" missing string "url"`);
    }
    if (typeof description !== "string") {
      throw new Error(`failed to parse registry ${source}: entry "${name}" missing string "description"`);
    }
    out[name] = { url, description };
  }
  return { libs: out };
}
