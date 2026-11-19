import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertAllowedRemoteScheme, REGISTRY_NAME_REGEX } from "./registry";

export interface LockEntry {
  name: string;
  url: string;
  version?: string;
  commit?: string;
  /** Detached minisign signature over the pinned commit SHA; re-verified on restore when present. */
  signature?: string;
}

export interface LockFile {
  libs: LockEntry[];
}

/** Last path segment of a clone URL, trailing slashes and a trailing `.git` stripped. May be empty/invalid — the caller validates it with `buildLibDir`. */
export function deriveLibName(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").pop() ?? trimmed;
  return lastSegment.replace(/\.git$/, "");
}

/**
 * Validate a lib name and return its directory under `libsDir`. The name — a
 * registry name, a URL-derived segment, or a lockfile entry's `name` — must be a
 * single safe path segment matching `REGISTRY_NAME_REGEX` (no `/`, no `.`/`..`,
 * never empty). After `join`, the parent of the result must still be `libsDir`,
 * so a crafted name can never remove or write a path outside `.jaiph/libs/`.
 * Throws naming `label` on any violation; callers run this before any clone or
 * `rmSync`, so a rejected name touches nothing.
 */
export function buildLibDir(name: string, libsDir: string, label: string): string {
  if (!REGISTRY_NAME_REGEX.test(name)) {
    throw new Error(`${label} name "${name}" is invalid — lib names must match ${REGISTRY_NAME_REGEX}`);
  }
  const libDir = join(libsDir, name);
  if (dirname(libDir) !== libsDir) {
    throw new Error(`${label} name "${name}" resolves outside ${libsDir}`);
  }
  return libDir;
}

/**
 * Reject a url or ref that could be read by git as an option (leading `-`) and
 * enforce the scheme allowlist. Keeps attacker-controlled lock/registry/URL
 * values from injecting `--upload-pack=…`-style arguments into `git clone`.
 */
export function assertSafeRemote(url: string, version: string | undefined, name: string): void {
  if (url.startsWith("-")) {
    throw new Error(`lib "${name}" url "${url}" must not start with "-"`);
  }
  if (version !== undefined && version.startsWith("-")) {
    throw new Error(`lib "${name}" ref "${version}" must not start with "-"`);
  }
  assertAllowedRemoteScheme(url, `lib "${name}" url`);
}

export function readLockFile(lockPath: string): LockFile {
  if (!existsSync(lockPath)) {
    return { libs: [] };
  }
  return validateLockShape(JSON.parse(readFileSync(lockPath, "utf8")), lockPath);
}

/**
 * Shape-check a parsed lockfile before any entry is acted on: `libs` must be an
 * array, each entry an object with a non-empty string `name` and `url` and
 * optional string `version` / `commit` / `signature`. A malformed lockfile is an
 * error naming the offending entry — the caller aborts and nothing is cloned or
 * removed, so an attacker-supplied lockfile cannot drive a clone from a value of
 * the wrong type.
 */
function validateLockShape(parsed: unknown, lockPath: string): LockFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid lockfile ${lockPath}: top-level must be an object`);
  }
  const libs = (parsed as { libs?: unknown }).libs;
  if (!Array.isArray(libs)) {
    throw new Error(`invalid lockfile ${lockPath}: "libs" must be an array`);
  }
  const out: LockEntry[] = [];
  for (let i = 0; i < libs.length; i++) {
    const raw = libs[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`invalid lockfile ${lockPath}: entry ${i} must be an object`);
    }
    const { name, url } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`invalid lockfile ${lockPath}: entry ${i} missing string "name"`);
    }
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`invalid lockfile ${lockPath}: entry "${name}" missing string "url"`);
    }
    const entry: LockEntry = { name, url };
    for (const key of ["version", "commit", "signature"] as const) {
      const val = (raw as Record<string, unknown>)[key];
      if (val === undefined) continue;
      if (typeof val !== "string") {
        throw new Error(`invalid lockfile ${lockPath}: entry "${name}" "${key}" must be a string`);
      }
      entry[key] = val;
    }
    out.push(entry);
  }
  return { libs: out };
}
