import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { colorPalette } from "../shared/errors";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag } from "../shared/usage";

const INSTALL_USAGE =
  "Usage: jaiph install [--force] [<repo-url[@version]> ...]\n\n" +
  "With one or more URLs, shallow-clone each repo into .jaiph/libs/<name>/ and\n" +
  "update .jaiph/libs.lock. With no args, restore every library listed in the\n" +
  "lockfile.\n\n" +
  "  --force         delete existing clone and re-clone\n" +
  "  -h, --help      show this help\n\n" +
  "Example:\n" +
  "  jaiph install https://github.com/you/queue-lib.git@v1.0\n";

interface LockEntry {
  name: string;
  url: string;
  version?: string;
}

interface LockFile {
  libs: LockEntry[];
}

export interface InstallSpec {
  name: string;
  url: string;
  version?: string;
  libDir: string;
}

export interface CloneOutcome {
  spec: InstallSpec;
  ok: boolean;
  message?: string;
}

export type CloneRunner = (spec: InstallSpec) => Promise<CloneOutcome>;

export interface RunInstallOptions {
  cwd?: string;
  cloneRunner?: CloneRunner;
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;

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

function specToLockEntry(spec: InstallSpec): LockEntry {
  return { name: spec.name, url: spec.url, ...(spec.version ? { version: spec.version } : {}) };
}

/** Default clone runner: `git clone --depth 1 [--branch <ref>] <url> <libDir>` via spawn. */
function gitCloneRunner(spec: InstallSpec): Promise<CloneOutcome> {
  return new Promise((done) => {
    const args = ["clone", "--depth", "1"];
    if (spec.version) {
      args.push("--branch", spec.version);
    }
    args.push(spec.url, spec.libDir);
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      done({ spec, ok: false, message: err.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        done({ spec, ok: true });
      } else {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        done({ spec, ok: false, message: tail ?? `git clone exited with code ${code}` });
      }
    });
  });
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function runInstall(rest: string[], opts: RunInstallOptions = {}): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(INSTALL_USAGE);
    return 0;
  }
  const palette = colorPalette();
  const force = rest.includes("--force");
  const args = rest.filter((a) => a !== "--force");
  const cwd = opts.cwd ?? process.cwd();
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const libsDir = join(workspaceRoot, ".jaiph", "libs");
  const lockPath = join(workspaceRoot, ".jaiph", "libs.lock");
  const cloneRunner = opts.cloneRunner ?? gitCloneRunner;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  mkdirSync(libsDir, { recursive: true });

  const isRestoreFromLock = args.length === 0;
  let lock: LockFile;
  let specs: InstallSpec[];

  if (isRestoreFromLock) {
    lock = readLockFile(lockPath);
    if (lock.libs.length === 0) {
      process.stdout.write("No libs in lockfile.\n");
      return 0;
    }
    process.stdout.write(`\nRestoring ${lock.libs.length} lib(s) from lockfile\n\n`);
    specs = lock.libs.map((e) => ({
      name: e.name,
      url: e.url,
      version: e.version,
      libDir: join(libsDir, e.name),
    }));
  } else {
    process.stdout.write("\n");
    lock = readLockFile(lockPath);
    specs = args.map((a) => {
      const { url, version } = parseUrlAndVersion(a);
      const name = deriveLibName(url);
      return { name, url, version, libDir: join(libsDir, name) };
    });
  }

  // Plan phase: skip warm-path libs without invoking the cloner; queue the rest.
  const skipped: InstallSpec[] = [];
  const jobs: InstallSpec[] = [];
  for (const spec of specs) {
    if (existsSync(spec.libDir)) {
      if (force) {
        rmSync(spec.libDir, { recursive: true, force: true });
        jobs.push(spec);
      } else {
        process.stdout.write(`${palette.dim}▸ ${spec.name} already exists, skipping (use --force to re-clone)${palette.reset}\n`);
        skipped.push(spec);
      }
    } else {
      jobs.push(spec);
    }
  }

  const outcomes = await runWithConcurrency(jobs, concurrency, cloneRunner);

  let allOk = true;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      const v = outcome.spec.version ? ` @ ${outcome.spec.version}` : "";
      process.stdout.write(`${palette.green}✓ Installed ${outcome.spec.name}${v}${palette.reset}\n`);
    } else {
      allOk = false;
      process.stderr.write(`Failed to install ${outcome.spec.name}: ${outcome.message ?? "unknown error"}\n`);
    }
  }

  if (!isRestoreFromLock) {
    for (const spec of skipped) {
      upsertLockEntry(lock, specToLockEntry(spec));
    }
    for (const outcome of outcomes) {
      if (outcome.ok) {
        upsertLockEntry(lock, specToLockEntry(outcome.spec));
      }
    }
    writeLockFile(lockPath, lock);
  }

  process.stdout.write("\n");
  return allOk ? 0 : 1;
}
