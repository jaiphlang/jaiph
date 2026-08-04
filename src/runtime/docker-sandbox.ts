import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";

// Sandbox-mode selection and host-side workspace snapshot cloning. Split out of
// `docker.ts` so each Docker concern stays under the analyzability line cap.

/** Selected sandbox primitive for a Docker run. */
export type SandboxMode = "snapshot" | "inplace";

/**
 * Choose the sandbox mode for the upcoming run.
 *
 * `JAIPH_INPLACE` is the opt-in: when truthy, the host workspace is
 * bind-mounted rw directly so the run's edits land live on the host. The
 * machine boundary (mount set, caps, env allowlist) is unchanged.
 *
 * Otherwise the default is `snapshot`: the host takes a writable point-in-time
 * clone of the workspace at run start and bind-mounts that clone rw. Host
 * changes during the run are invisible to the container; container workspace
 * writes are discarded at exit; the live host workspace is never mounted. No
 * device probing and no elevated capabilities are involved.
 */
export function selectSandboxMode(env: Record<string, string | undefined>): SandboxMode {
  if (env.JAIPH_INPLACE === "1" || env.JAIPH_INPLACE === "true") {
    return "inplace";
  }
  return "snapshot";
}

/**
 * Choose the sandbox mode for a `jaiph mcp` tool call.
 *
 * Delegates to `selectSandboxMode` so MCP and `jaiph run` share identical
 * semantics: a point-in-time snapshot by default (workspace isolated), inplace
 * only when `JAIPH_INPLACE=1|true`. Kept as a named export so callers and tests
 * import a stable symbol.
 */
export function selectMcpSandboxMode(env: Record<string, string | undefined>): SandboxMode {
  return selectSandboxMode(env);
}

/**
 * Test seam for the `cp` spawn — lets clone tests assert the flags chosen per
 * platform without a real filesystem copy.
 */
export const _cpSpawn = {
  run(args: string[]): { status: number | null; stderr: string } {
    const r = spawnSync("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    return { status: r.status, stderr: r.stderr?.toString() ?? "" };
  },
};

/** Run `cp` with the given flags. Returns true on success. */
function tryCp(flags: string[], src: string, dst: string): { ok: boolean; stderr: string } {
  const r = _cpSpawn.run([...flags, src, dst]);
  return { ok: r.status === 0, stderr: r.stderr };
}

/**
 * Test seam for `git ls-files` — lets the snapshot content-policy tests assert
 * on the git-driven file selection without a real repo, and lets callers inject
 * a deterministic file list.
 *
 * `ok: false` means "not a git workspace" (git absent, no repo, or the command
 * failed): the caller falls back to copy-everything. Paths are workspace-
 * relative, `/`-separated (git's native output), NUL-split from `-z`.
 */
export const _gitLsFiles = {
  run(srcRootAbs: string): { ok: boolean; paths: string[] } {
    try {
      const out = execFileSync(
        "git",
        ["-C", srcRootAbs, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
      );
      return { ok: true, paths: out.split("\0").filter((p) => p.length > 0) };
    } catch {
      return { ok: false, paths: [] };
    }
  },
};

/**
 * Resolve the workspace-relative paths that make up a git snapshot, or `null`
 * for a non-git workspace (no `.git` at the root, or `git ls-files` failed) —
 * signalling the copy-everything fallback.
 *
 * git is the single gitignore oracle: the returned list is exactly
 * `git ls-files --cached --others --exclude-standard` (tracked + untracked-but-
 * not-ignored). We never reimplement ignore semantics (nested ignores, `!`
 * negations, `.git/info/exclude`, global excludes) — those all live in git's answer.
 */
function gitSnapshotRelPaths(srcRootAbs: string): string[] | null {
  if (!existsSync(join(srcRootAbs, ".git"))) return null;
  const r = _gitLsFiles.run(srcRootAbs);
  return r.ok ? r.paths : null;
}

/**
 * Handles workspace cloning with automatic clonefile detection and fallback.
 *
 * On macOS, the first `copy()` call probes `cp -cR` (APFS clonefile, O(1)).
 * If it works, subsequent calls use clonefile directly. If it fails, all calls
 * fall back to `cp -pR` and the reason is recorded for a one-time warning.
 * On Linux/other platforms, uses `cp --reflink=auto -pR`: block-level CoW on
 * btrfs/XFS, with `cp`'s own transparent data-copy fallback on ext4 and
 * cross-filesystem destinations (e.g. a `JAIPH_RUNS_DIR` on another volume).
 */
class WorkspaceCloner {
  private cloneAttempted = false;
  private cloneSupported = false;
  private firstFallbackReason: string | null = null;

  /** Run one `cp` variant, throwing E_DOCKER_SANDBOX_COPY when it fails. */
  private copyOrThrow(flags: string[], src: string, dst: string): void {
    const r = tryCp(flags, src, dst);
    if (!r.ok) {
      throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${r.stderr.trim()}`);
    }
  }

  copy(src: string, dst: string): void {
    if (process.platform !== "darwin") {
      this.copyOrThrow(["--reflink=auto", "-pR"], src, dst);
      return;
    }

    if (!this.cloneAttempted) {
      this.cloneAttempted = true;
      const r = tryCp(["-cR"], src, dst);
      if (r.ok) {
        this.cloneSupported = true;
        return;
      }
      this.firstFallbackReason = r.stderr.trim().split("\n")[0] || "cp -cR failed";
      this.copyOrThrow(["-pR"], src, dst);
      return;
    }

    if (this.cloneSupported) {
      const r = tryCp(["-cR"], src, dst);
      if (r.ok) return;
    }
    this.copyOrThrow(["-pR"], src, dst);
  }

  get fellBackToPlainCopy(): boolean {
    return this.cloneAttempted && !this.cloneSupported;
  }

  get fallbackReason(): string {
    return this.firstFallbackReason ?? "unknown reason";
  }
}

/**
 * Clone the host workspace into a sandbox directory.
 *
 * Copy mechanism (identical for both content policies below):
 * - macOS: tries `cp -cR` (APFS clonefile, O(1)); on failure, falls back to
 *   `cp -pR` (real copy) with a single stderr warning noting the reason.
 * - Linux/other: uses `cp --reflink=auto -pR` (block-level CoW on btrfs/XFS,
 *   transparent data-copy fallback on ext4 and cross-filesystem destinations).
 *
 * Content policy (uniform across every platform and copy mechanism — what the
 * container sees never depends on which `cp` variant ran):
 * - **Git workspace** (`.git` at the root and `git ls-files` succeeds): the
 *   snapshot contains exactly the files git reports (tracked + untracked-but-
 *   not-ignored, via `git ls-files --cached --others --exclude-standard`) plus
 *   `.git/` wholesale (workflows need history and commit inside the sandbox).
 *   Gitignored files (`.env`, `node_modules/`, …) are **absent** — never copied,
 *   never even scanned. git is the only gitignore oracle; we consume its list
 *   rather than reimplement ignore semantics. Submodule directories appear as a
 *   single gitlink path in the list and are copied wholesale as opaque dirs.
 *   Tracked-but-deleted-from-worktree paths are silently skipped (the on-disk
 *   walk only copies entries that exist).
 * - **Non-git workspace**: copy everything (minus the runs root). This is the
 *   documented fallback — an "ignored-looking" file with no git to consult is
 *   copied.
 *
 * Both policies still exclude `.jaiph/runs` (mounted separately at `/jaiph/run`).
 * `runsRootAbs` additionally excludes the actual configured runs directory when
 * `JAIPH_RUNS_DIR` points somewhere other than `.jaiph/runs` (defaults to
 * `.jaiph/runs` when omitted). Without this, a runs dir nested inside the
 * workspace (e.g. a relative `JAIPH_RUNS_DIR`) would have the sandbox clone
 * created *inside* it, and GNU `cp` refuses to copy a directory into itself.
 */
export function cloneWorkspaceForSandbox(
  srcRoot: string,
  dstRoot: string,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
  runsRootAbs?: string,
): void {
  const srcRootAbs = resolve(srcRoot);
  const defaultRunsRoot = join(srcRootAbs, ".jaiph", "runs");
  const excludes = new Set([defaultRunsRoot, runsRootAbs ? resolve(runsRootAbs) : defaultRunsRoot]);
  const cloner = new WorkspaceCloner();

  // Excludes-aware entry-by-entry recursion. Used for the non-git fallback and
  // for the `.git/` wholesale copy when the runs dir is nested inside `.git`
  // (unusual). Prunes at directory granularity: an excluded subtree is skipped.
  const copyDirExcluding = (srcDir: string, dstDir: string): void => {
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      if (excludes.has(srcPath)) continue;
      if (entry.isDirectory() && [...excludes].some((ex) => ex.startsWith(srcPath + sep))) {
        copyDirExcluding(srcPath, join(dstDir, entry.name));
        continue;
      }
      cloner.copy(srcPath, join(dstDir, entry.name));
    }
  };

  const gitPaths = gitSnapshotRelPaths(srcRootAbs);
  if (gitPaths === null) {
    // Non-git fallback: copy everything (minus the runs root).
    copyDirExcluding(srcRootAbs, dstRoot);
  } else {
    // Git workspace: copy exactly git's file list, pruning at directory
    // granularity. `allowedFiles` are the leaf paths to copy; `allowedDirs` are
    // the ancestor directories we descend into — an entirely-ignored subtree
    // (e.g. `node_modules/`) is in neither set, so it is never scanned.
    const allowedFiles = new Set<string>();
    const allowedDirs = new Set<string>();
    for (const rel of gitPaths) {
      const abs = join(srcRootAbs, rel);
      if (excludes.has(abs) || [...excludes].some((ex) => abs.startsWith(ex + sep))) continue;
      allowedFiles.add(abs);
      for (let dir = dirname(abs); dir !== srcRootAbs && dir.startsWith(srcRootAbs + sep); dir = dirname(dir)) {
        allowedDirs.add(dir);
      }
    }

    const copyGitDir = (srcDir: string, dstDir: string): void => {
      mkdirSync(dstDir, { recursive: true });
      for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = join(srcDir, entry.name);
        if (entry.isDirectory()) {
          if (allowedDirs.has(srcPath)) {
            copyGitDir(srcPath, join(dstDir, entry.name));
          } else if (allowedFiles.has(srcPath)) {
            // Submodule gitlink: git lists it as a single opaque path. Copy the
            // whole directory (recursion into it would find nothing allowed).
            cloner.copy(srcPath, join(dstDir, entry.name));
          }
          // Otherwise entirely ignored: pruned — never scanned or recursed.
        } else if (allowedFiles.has(srcPath)) {
          cloner.copy(srcPath, join(dstDir, entry.name));
        }
        // A tracked-but-deleted path never appears in this on-disk walk.
      }
    };
    copyGitDir(srcRootAbs, dstRoot);

    // `.git/` wholesale — workflows need history/commit inside the sandbox.
    const gitDir = join(srcRootAbs, ".git");
    if (existsSync(gitDir)) {
      if ([...excludes].some((ex) => ex.startsWith(gitDir + sep))) {
        // Runs dir nested inside `.git` (unusual): recurse with the excludes
        // filter so the snapshot source is not copied into itself.
        copyDirExcluding(gitDir, join(dstRoot, ".git"));
      } else {
        cloner.copy(gitDir, join(dstRoot, ".git"));
      }
    }
  }

  if (process.platform === "darwin" && cloner.fellBackToPlainCopy) {
    warn(
      `jaiph docker: clonefile (cp -cR) unavailable on this filesystem; using plain copy ` +
      `(${cloner.fallbackReason}). Workspace clone may be slow for large trees.`,
    );
  }
}

/**
 * The host-side snapshot directory for a run: `<runsRoot>/sandbox`.
 *
 * Uniqueness comes from the run's runs root (one run per invocation); crash
 * orphans are swept with the run-dir lifecycle. The runs root is bind-mounted
 * at `/jaiph/run` and excluded from its own clone (see `cloneWorkspaceForSandbox`),
 * so the snapshot never copies itself; the container cannot read it back through
 * `/jaiph/run` because `buildDockerArgs` masks `/jaiph/run/sandbox` with a tmpfs.
 */
export function allocateSandboxWorkspaceDir(runsRoot: string): string {
  const dir = join(runsRoot, "sandbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}
