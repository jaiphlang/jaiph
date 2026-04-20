import { execFileSync, execSync, spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";

// ---------------------------------------------------------------------------
// Mount validation (used by isolated execution)
// ---------------------------------------------------------------------------

/**
 * Host paths that must never be bind-mounted into a container.
 * Prevents accidental exposure of the Docker daemon, OS internals, or
 * the entire root filesystem.
 */
const DENIED_HOST_PATHS = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/proc",
  "/sys",
  "/dev",
] as const;

/**
 * Validate a single mount's host path against the denylist.
 * Rejects exact matches and child paths (e.g. `/proc/1/root`).
 */
export function validateMountHostPath(hostAbsPath: string): void {
  const normalized = hostAbsPath.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") {
    throw new Error(
      `E_VALIDATE_MOUNT refusing to mount the host root filesystem ("/") into the container`,
    );
  }
  for (const denied of DENIED_HOST_PATHS) {
    if (normalized === denied || normalized.startsWith(denied + "/")) {
      throw new Error(
        `E_VALIDATE_MOUNT refusing to mount denied host path "${hostAbsPath}" into the container`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

/** Read the package version to derive the default GHCR image tag. */
function resolveDefaultImageTag(): string {
  try {
    const pkgPath = resolve(__dirname, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // Fall through to nightly.
  }
  return "nightly";
}

export const GHCR_IMAGE_REPO = "ghcr.io/jaiphlang/jaiph-runtime";

export function pullImageIfNeeded(image: string): void {
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore", timeout: 30_000 });
  } catch {
    // Image not present locally — pull it
    try {
      execSync(`docker pull ${image}`, { stdio: "inherit", timeout: 300_000 });
    } catch {
      throw new Error(`E_DOCKER_PULL failed to pull image "${image}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dockerfile-based image build
// ---------------------------------------------------------------------------

const DOCKERFILE_IMAGE_TAG = "jaiph-runtime:latest";

/**
 * Build a Docker image from a Dockerfile and tag it.
 *
 * Skips the build entirely when an image with `tag` already exists locally.
 * The runtime has no way to know whether the existing image is "fresh enough"
 * for the user's intent (Dockerfile contents alone are insufficient: layers
 * like `RUN jaiph use nightly` depend on remote state that Docker's layer
 * cache cannot detect changes in). Re-tagging on every call would silently
 * overwrite manually-built images (e.g. one the user just rebuilt with
 * `--no-cache`) with a stale-cached version. So: build only when the tag is
 * absent, otherwise trust the existing image. Users who need a refresh run
 * `docker build` (or `docker rmi <tag>`) themselves.
 *
 * Build output is captured (not inherited) so it never corrupts the host TTY's
 * live progress frame. On failure, the captured output is included in the
 * thrown error so the user can diagnose.
 *
 * Throws on build failure.
 */
export function buildImageFromDockerfile(dockerfilePath: string, tag: string = DOCKERFILE_IMAGE_TAG): string {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: "ignore", timeout: 30_000 });
    return tag;
  } catch {
    // Image absent — fall through to build
  }
  const contextDir = dirname(dockerfilePath);
  try {
    // --pull --no-cache: this branch only fires when the image is absent
    // (the existence check above short-circuits otherwise), so any RUN layers
    // that depend on remote state (e.g. `RUN jaiph use nightly`) must reflect
    // current remote state, not a months-old cached layer. Users who want a
    // refresh delete the image (`docker rmi`) and the next run rebuilds clean.
    execSync(`docker build --pull --no-cache -t ${tag} -f ${dockerfilePath} ${contextDir}`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
  } catch (err: unknown) {
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    const tail = (stdout + stderr).split("\n").slice(-40).join("\n");
    throw new Error(
      `E_DOCKER_BUILD failed to build image from "${dockerfilePath}"\n${tail}`,
    );
  }
  return tag;
}

function imageHasJaiph(image: string): boolean {
  try {
    execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", image, "-lc", "command -v jaiph >/dev/null 2>&1"],
      { stdio: "ignore", timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that the selected Docker image contains `jaiph`.
 * Fails fast with an actionable error when the binary is missing.
 */
export function verifyImageHasJaiph(image: string): void {
  if (!imageHasJaiph(image)) {
    throw new Error(
      `E_DOCKER_NO_JAIPH the Docker image "${image}" does not contain a jaiph CLI. ` +
      `Use the official runtime image (${GHCR_IMAGE_REPO}:<version>) or install jaiph ` +
      `in your custom image. See https://jaiph.org/sandboxing for details.`,
    );
  }
}

/**
 * Resolve the Docker image to use for isolated execution.
 *
 * When the image was not explicitly configured (`imageExplicit === false`),
 * checks for `.jaiph/Dockerfile` in the workspace root. If present, builds
 * from it and verifies jaiph is present. Otherwise uses the configured
 * (default) image — the official GHCR runtime image — and pulls if needed.
 *
 * All images are verified to contain `jaiph` before use.
 */
export function resolveImage(image: string, imageExplicit: boolean, workspaceRoot: string): string {
  let resolved = image;
  if (!imageExplicit) {
    const dockerfilePath = join(workspaceRoot, ".jaiph", "Dockerfile");
    if (existsSync(dockerfilePath)) {
      resolved = buildImageFromDockerfile(dockerfilePath);
    } else {
      pullImageIfNeeded(resolved);
    }
  } else {
    pullImageIfNeeded(resolved);
  }
  verifyImageHasJaiph(resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Container constants and env filtering
// ---------------------------------------------------------------------------

export const CONTAINER_WORKSPACE = "/jaiph/workspace";
export const CONTAINER_RUN_DIR = "/jaiph/run";
const AGENT_ENV_PREFIXES = ["CURSOR_", "ANTHROPIC_", "CLAUDE_"] as const;

/**
 * Environment variable prefixes that are never forwarded into the container.
 * Prevents leaking host credentials that aren't part of the explicit allowlist.
 */
export const ENV_DENYLIST_PREFIXES = [
  "SSH_",
  "GPG_",
  "AWS_",
  "GCP_",
  "AZURE_",
  "GOOGLE_",
  "DOCKER_",
  "KUBE",
  "NPM_TOKEN",
] as const;

/** Returns true if `key` matches any denied prefix. */
export function isEnvDenied(key: string): boolean {
  return ENV_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Workspace patch export (container teardown)
// ---------------------------------------------------------------------------

/**
 * Export a git diff of workspace changes to a patch file.
 * Used during container teardown to capture sandbox-local modifications.
 *
 * Contract:
 * - When there are changes, writes `workspace.patch` (git apply-able).
 * - When there are no changes, the file is omitted (not created).
 * - Best-effort: failures are reported on stderr but do not affect workflow exit status.
 *
 * @returns true if a non-empty patch was written.
 */
export function exportWorkspacePatch(workspaceDir: string, outputPath: string): boolean {
  try {
    // Stage intent-to-add for untracked files so they appear in git diff
    execSync("git add -N .", { cwd: workspaceDir, stdio: "ignore", timeout: 30_000 });
  } catch {
    // Not a git repo or no new files — continue to diff
  }
  try {
    const diff = execSync("git diff --binary", {
      cwd: workspaceDir,
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!diff || diff.length === 0) return false;
    writeFileSync(outputPath, diff);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jaiph isolated: workspace patch export failed: ${msg}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run artifact discovery (used by isolated branch output retrieval)
// ---------------------------------------------------------------------------

export function findRunArtifacts(
  sandboxRunDir: string,
): { runDir?: string; summaryFile?: string } {
  if (!existsSync(sandboxRunDir)) return {};
  const candidates: string[] = [];
  for (const dateDir of readdirSync(sandboxRunDir)) {
    const datePath = join(sandboxRunDir, dateDir);
    if (!statSync(datePath).isDirectory()) continue;
    for (const runEntry of readdirSync(datePath)) {
      const runPath = join(datePath, runEntry);
      if (!statSync(runPath).isDirectory()) continue;
      candidates.push(runPath);
    }
  }
  candidates.sort();
  const runDir = candidates[candidates.length - 1];
  if (!runDir) return {};
  const summaryFile = join(runDir, "run_summary.jsonl");
  return {
    runDir,
    summaryFile: existsSync(summaryFile) ? summaryFile : undefined,
  };
}

// ---------------------------------------------------------------------------
// Isolated execution backend (per-call Docker + fuse-overlayfs, no fallback)
// ---------------------------------------------------------------------------

/**
 * Strict overlay script for `run isolated`. Fails hard if fuse-overlayfs is
 * unavailable — no rsync / cp -a fallback chain.
 */
const ISOLATED_OVERLAY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
LOWER=/jaiph/workspace-ro
UPPER=/tmp/overlay-upper
WORK=/tmp/overlay-work
MERGED=/jaiph/workspace
mkdir -p "$UPPER" "$WORK" "$MERGED"
if ! command -v fuse-overlayfs >/dev/null 2>&1 || [ ! -e /dev/fuse ]; then
  printf 'jaiph isolated: fuse-overlayfs or /dev/fuse is not available in this container — isolated execution requires fuse-overlayfs in Docker; install Docker with fuse support or load the fuse module\\n' >&2
  exit 126
fi
if ! fuse-overlayfs -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK" "$MERGED" 2>/tmp/jaiph-fuse-overlay.err; then
  reason="$(tr '\\n' ' ' </tmp/jaiph-fuse-overlay.err | sed 's/[[:space:]]\\+/ /g; s/^ //; s/ $//')"
  printf 'jaiph isolated: fuse-overlayfs mount failed: %s\\n' "$reason" >&2
  exit 126
fi
probe_path="$(mktemp "$MERGED/.jaiph-overlay-probe.XXXXXX" 2>/dev/null || true)"
if [ -z "$probe_path" ]; then
  printf 'jaiph isolated: fuse-overlayfs mounted but workspace is not writable\\n' >&2
  exit 126
fi
rm -f "$probe_path"
exec "$@"
`;

/** Write the strict isolated overlay script to a temp file. */
export function writeIsolatedOverlayScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-isolated-"));
  const scriptPath = join(dir, "isolated-overlay-run.sh");
  writeFileSync(scriptPath, ISOLATED_OVERLAY_SCRIPT, { mode: 0o755 });
  return scriptPath;
}

/** Resolve isolated image from env or use the default GHCR image. */
export function resolveIsolatedImage(env: Record<string, string | undefined>): string {
  if (env.JAIPH_ISOLATED_IMAGE) return env.JAIPH_ISOLATED_IMAGE;
  return `${GHCR_IMAGE_REPO}:${resolveDefaultImageTag()}`;
}

export interface IsolatedSpawnOptions {
  /** Absolute path to the .jh source file. */
  sourceAbs: string;
  /** Host workspace root directory. */
  workspaceRoot: string;
  /** Host directory for this branch's run artifacts (mounted at /jaiph/run:rw). */
  branchRunDir: string;
  /** Named workflow to run inside the container. */
  workflowName: string;
  /** Arguments to pass to the workflow. */
  runArgs: string[];
  /** Host environment. */
  env: Record<string, string | undefined>;
  /** Container image override (resolved from JAIPH_ISOLATED_IMAGE or default). */
  image: string;
  /** Network mode. */
  network: string;
  /** Timeout in seconds. */
  timeout: number;
}

/**
 * Build Docker args for an isolated per-call container.
 * Uses the strict overlay script and runs a specific named workflow
 * via `jaiph run --raw --entry <name>`.
 */
export function buildIsolatedDockerArgs(opts: IsolatedSpawnOptions, overlayScriptPath: string): string[] {
  const args: string[] = ["run", "--rm"];

  // Least-privilege: drop all capabilities, re-add only SYS_ADMIN for fuse-overlayfs.
  // Note: no-new-privileges is NOT set here because fusermount3 is setuid and
  // requires privilege escalation to mount the FUSE filesystem.
  args.push("--cap-drop", "ALL");
  args.push("--cap-add", "SYS_ADMIN");
  args.push("--device", "/dev/fuse");

  // Docker default: separate PID namespace (container processes isolated from host).

  if (process.platform === "linux") {
    try {
      const uid = execSync("id -u", { encoding: "utf8" }).trim();
      const gid = execSync("id -g", { encoding: "utf8" }).trim();
      args.push("--user", `${uid}:${gid}`);
    } catch {
      // Fall through without --user
    }
  }

  if (opts.network !== "default") {
    args.push("--network", opts.network);
  }

  // Workspace: mounted read-only at the overlay lower-layer path
  const hostWorkspaceAbs = resolve(opts.workspaceRoot);
  validateMountHostPath(hostWorkspaceAbs);
  args.push("-v", `${hostWorkspaceAbs}:${CONTAINER_WORKSPACE}-ro:ro`);

  // Branch run artifacts directory: rw mount outside the overlay
  args.push("-v", `${opts.branchRunDir}:${CONTAINER_RUN_DIR}:rw`);

  // Overlay entrypoint script (runtime-generated, mounted ro)
  args.push("-v", `${overlayScriptPath}:/jaiph/overlay-run.sh:ro`);

  // Environment: JAIPH_* vars (minus denied prefixes) + isolation sentinel
  const containerEnv: Record<string, string> = {
    JAIPH_WORKSPACE: CONTAINER_WORKSPACE,
    JAIPH_RUNS_DIR: CONTAINER_RUN_DIR,
    JAIPH_ISOLATED: "1",
  };

  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    if (isEnvDenied(key)) continue;
    if (key.startsWith("JAIPH_") && !key.startsWith("JAIPH_DOCKER_")) {
      containerEnv[key] = value;
    }
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      containerEnv[key] = value;
    }
  }
  // Override workspace/runs with container paths
  containerEnv.JAIPH_WORKSPACE = CONTAINER_WORKSPACE;
  containerEnv.JAIPH_RUNS_DIR = CONTAINER_RUN_DIR;
  containerEnv.JAIPH_ISOLATED = "1";

  for (const [key, value] of Object.entries(containerEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push("-w", CONTAINER_WORKSPACE);
  args.push(opts.image);

  // Command: overlay wrapper → jaiph run --raw --entry <workflow_name>
  const relSource = relative(opts.workspaceRoot, opts.sourceAbs);
  args.push(
    "/jaiph/overlay-run.sh",
    "jaiph", "run", "--raw", "--entry", opts.workflowName,
    `${CONTAINER_WORKSPACE}/${relSource}`,
    ...opts.runArgs,
  );

  return args;
}

export interface IsolatedSpawnResult {
  child: ChildProcess;
  branchRunDir: string;
  overlayScriptDir: string;
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * Check that the isolated execution backend (Docker + fuse-overlayfs) is available.
 * Throws with an actionable error message if not.
 */
export function checkIsolatedBackendAvailable(): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10_000 });
  } catch {
    throw new Error(
      "isolated execution requires fuse-overlayfs in Docker; install Docker and ensure the daemon is running. " +
      "See https://jaiph.org/sandboxing for details.",
    );
  }
}

/**
 * Spawn an isolated container for a single `run isolated` call.
 * Returns a handle with the child process and cleanup metadata.
 */
export function spawnIsolatedProcess(opts: IsolatedSpawnOptions): IsolatedSpawnResult {
  checkIsolatedBackendAvailable();

  const resolvedImage = resolveImage(
    opts.image,
    !!opts.env.JAIPH_ISOLATED_IMAGE,
    opts.workspaceRoot,
  );

  mkdirSync(opts.branchRunDir, { recursive: true });
  const overlayScriptPath = writeIsolatedOverlayScript();
  const overlayScriptDir = dirname(overlayScriptPath);
  const dockerArgs = buildIsolatedDockerArgs({ ...opts, image: resolvedImage }, overlayScriptPath);

  const child = spawn("docker", dockerArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.workspaceRoot,
    env: opts.env,
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* no-op */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* no-op */ }
      }, 5000);
    }, opts.timeout * 1000);
  }

  return { child, branchRunDir: opts.branchRunDir, overlayScriptDir, timeoutTimer };
}

/** Clean up isolated container resources after execution. */
export function cleanupIsolated(result: IsolatedSpawnResult): void {
  if (result.timeoutTimer) clearTimeout(result.timeoutTimer);
  try {
    rmSync(result.overlayScriptDir, { recursive: true, force: true });
  } catch { /* Best-effort cleanup */ }
}
