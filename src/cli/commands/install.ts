import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { colorPalette } from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";

interface LockEntry {
  name: string;
  url: string;
  version?: string;
}

interface LockFile {
  libs: LockEntry[];
}

function deriveLibName(url: string): string {
  const lastSegment = url.split("/").pop() ?? url;
  return lastSegment.replace(/\.git$/, "");
}

/** Splits a clone URL and optional @ref. Ref after `.../.git@` is recognized for any transport (https, git@, scp). */
export function parseUrlAndVersion(arg: string): { url: string; version?: string } {
  const m = arg.match(/^(.+?\.git)@([A-Za-z0-9._+/-]+)$/);
  if (m) {
    return { url: m[1], version: m[2] };
  }
  const atIdx = arg.lastIndexOf("@");
  // Avoid splitting on @ in protocols like git@github.com:... or user:pass@host/...
  if (atIdx > 0 && !arg.slice(0, atIdx).includes("://") && !arg.slice(0, atIdx).includes(":")) {
    return { url: arg.slice(0, atIdx), version: arg.slice(atIdx + 1) };
  }
  return { url: arg };
}

function readLockFile(lockPath: string): LockFile {
  if (!existsSync(lockPath)) {
    return { libs: [] };
  }
  return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
}

function writeLockFile(lockPath: string, lock: LockFile): void {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

function upsertLockEntry(lock: LockFile, entry: LockEntry): void {
  const idx = lock.libs.findIndex((e) => e.name === entry.name);
  if (idx >= 0) {
    lock.libs[idx] = entry;
  } else {
    lock.libs.push(entry);
  }
}

function cloneLib(
  url: string,
  version: string | undefined,
  targetDir: string,
  force: boolean,
  palette: ReturnType<typeof colorPalette>,
): boolean {
  const name = deriveLibName(url);
  const libDir = join(targetDir, name);

  if (existsSync(libDir)) {
    if (force) {
      rmSync(libDir, { recursive: true, force: true });
    } else {
      process.stdout.write(`${palette.dim}▸ ${name} already exists, skipping (use --force to re-clone)${palette.reset}\n`);
      return true;
    }
  }

  const branchFlag = version ? ` --branch ${version}` : "";
  const cmd = `git clone --depth 1${branchFlag} ${url} ${libDir}`;
  try {
    execSync(cmd, { stdio: "pipe" });
    process.stdout.write(`${palette.green}✓ Installed ${name}${version ? ` @ ${version}` : ""}${palette.reset}\n`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to install ${name}: ${msg}\n`);
    return false;
  }
}

export function runInstall(rest: string[]): number {
  const palette = colorPalette();
  const force = rest.includes("--force");
  const args = rest.filter((a) => a !== "--force");
  const workspaceRoot = detectWorkspaceRoot(process.cwd());
  const libsDir = join(workspaceRoot, ".jaiph", "libs");
  const lockPath = join(workspaceRoot, ".jaiph", "libs.lock");

  mkdirSync(libsDir, { recursive: true });

  // No args: restore from lockfile
  if (args.length === 0) {
    const lock = readLockFile(lockPath);
    if (lock.libs.length === 0) {
      process.stdout.write("No libs in lockfile.\n");
      return 0;
    }
    process.stdout.write(`\nRestoring ${lock.libs.length} lib(s) from lockfile\n\n`);
    let ok = true;
    for (const entry of lock.libs) {
      if (!cloneLib(entry.url, entry.version, libsDir, force, palette)) {
        ok = false;
      }
    }
    process.stdout.write("\n");
    return ok ? 0 : 1;
  }

  // Install each specified lib
  process.stdout.write("\n");
  const lock = readLockFile(lockPath);
  let ok = true;
  for (const arg of args) {
    const { url, version } = parseUrlAndVersion(arg);
    const name = deriveLibName(url);
    if (!cloneLib(url, version, libsDir, force, palette)) {
      ok = false;
      continue;
    }
    upsertLockEntry(lock, { name, url, ...(version ? { version } : {}) });
  }
  writeLockFile(lockPath, lock);
  process.stdout.write("\n");
  return ok ? 0 : 1;
}
