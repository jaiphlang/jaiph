import { execSync, spawn, ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import type { RuntimeConfig } from "../types";

/** Parsed mount specification. */
export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

/** Resolved Docker runtime config with defaults applied and env overrides merged. */
export interface DockerRunConfig {
  enabled: boolean;
  image: string;
  /** True when image was explicitly set via env or in-file config (not the default). */
  imageExplicit: boolean;
  network: string;
  timeout: number;
  mounts: MountSpec[];
}

// ---------------------------------------------------------------------------
// Mount parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single mount string.
 * - 3 segments: `"host:container:mode"`
 * - 2 segments: `"host:mode"` → mounts at `/jaiph/workspace/<host>`
 * - 1 segment → error
 */
export function parseMount(spec: string): MountSpec {
  const parts = spec.split(":");
  if (parts.length === 3) {
    const [hostPath, containerPath, mode] = parts;
    if (mode !== "ro" && mode !== "rw") {
      throw new Error(`E_PARSE mount mode must be "ro" or "rw", got "${mode}" in "${spec}"`);
    }
    return { hostPath, containerPath, mode };
  }
  if (parts.length === 2) {
    const [hostPath, mode] = parts;
    if (mode !== "ro" && mode !== "rw") {
      throw new Error(`E_PARSE mount mode must be "ro" or "rw", got "${mode}" in "${spec}"`);
    }
    return { hostPath, containerPath: `/jaiph/workspace/${hostPath}`, mode };
  }
  throw new Error(`E_PARSE mount spec must have 2 or 3 colon-separated segments, got "${spec}"`);
}

/**
 * Parse and validate all mount specs.
 * Enforces: exactly one mount must target `/jaiph/workspace`.
 */
export function parseMounts(specs: string[]): MountSpec[] {
  const mounts = specs.map(parseMount);
  validateMounts(mounts);
  return mounts;
}

/**
 * Validate mount list: exactly one mount must target `/jaiph/workspace`.
 */
export function validateMounts(mounts: MountSpec[]): void {
  const workspaceMounts = mounts.filter(
    (m) => m.containerPath === "/jaiph/workspace" || m.containerPath.replace(/\/+$/, "") === "/jaiph/workspace",
  );
  if (workspaceMounts.length === 0) {
    throw new Error("E_VALIDATE exactly one mount must target /jaiph/workspace");
  }
  if (workspaceMounts.length > 1) {
    throw new Error("E_VALIDATE exactly one mount must target /jaiph/workspace, found multiple");
  }
}

// ---------------------------------------------------------------------------
// Config resolution (env > in-file > defaults)
// ---------------------------------------------------------------------------

const DEFAULTS: DockerRunConfig = {
  enabled: false,
  /** Node + bash; required for JS kernel (run-step-exec) inside the container. */
  image: "node:20-bookworm",
  imageExplicit: false,
  network: "default",
  timeout: 300,
  mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
};

/**
 * Resolve effective Docker config.
 * Precedence: env vars (`JAIPH_DOCKER_*`) > in-file RuntimeConfig > defaults.
 * Docker is disabled by default; opt in via config or env.
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  // enabled: env > in-file > default (false)
  let enabled: boolean;
  if (env.JAIPH_DOCKER_ENABLED !== undefined) {
    enabled = env.JAIPH_DOCKER_ENABLED === "true";
  } else if (inFile?.dockerEnabled !== undefined) {
    enabled = inFile.dockerEnabled;
  } else {
    enabled = DEFAULTS.enabled;
  }

  // image: env > in-file > default
  const imageExplicit = env.JAIPH_DOCKER_IMAGE !== undefined || inFile?.dockerImage !== undefined;
  const image =
    env.JAIPH_DOCKER_IMAGE ??
    inFile?.dockerImage ??
    DEFAULTS.image;

  // network: env > in-file > default
  const network =
    env.JAIPH_DOCKER_NETWORK ??
    inFile?.dockerNetwork ??
    DEFAULTS.network;

  // timeout: env > in-file > default
  let timeout: number;
  if (env.JAIPH_DOCKER_TIMEOUT !== undefined) {
    timeout = parseInt(env.JAIPH_DOCKER_TIMEOUT, 10);
    if (isNaN(timeout)) timeout = DEFAULTS.timeout;
  } else {
    timeout = inFile?.dockerTimeout ?? DEFAULTS.timeout;
  }

  // workspace mounts: in-file > default (not overridable via env)
  const mountSpecs = inFile?.workspace ?? DEFAULTS.mounts.map((m) => `${m.hostPath}:${m.containerPath}:${m.mode}`);
  const mounts = typeof mountSpecs[0] === "string"
    ? parseMounts(mountSpecs as string[])
    : (mountSpecs as unknown as MountSpec[]);

  return { enabled, image, imageExplicit, network, timeout, mounts };
}

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export function checkDockerAvailable(): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10_000 });
  } catch {
    throw new Error("E_DOCKER_NOT_FOUND docker is not available. Install Docker and ensure the daemon is running.");
  }
}

// ---------------------------------------------------------------------------
// Image pull
// ---------------------------------------------------------------------------

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
 * Throws on build failure.
 */
export function buildImageFromDockerfile(dockerfilePath: string, tag: string = DOCKERFILE_IMAGE_TAG): string {
  const contextDir = dirname(dockerfilePath);
  try {
    execSync(`docker build -t ${tag} -f ${dockerfilePath} ${contextDir}`, {
      stdio: "inherit",
      timeout: 600_000,
    });
  } catch {
    throw new Error(`E_DOCKER_BUILD failed to build image from "${dockerfilePath}"`);
  }
  return tag;
}

/**
 * Resolve the Docker image to use.
 *
 * When the image was not explicitly configured (`imageExplicit === false`),
 * checks for `.jaiph/Dockerfile` in the workspace root. If present, builds
 * from it and returns the built image tag. Otherwise falls back to the
 * configured (default) image and pulls it if needed.
 */
export function resolveImage(config: DockerRunConfig, workspaceRoot: string): string {
  if (!config.imageExplicit) {
    const dockerfilePath = join(workspaceRoot, ".jaiph", "Dockerfile");
    if (existsSync(dockerfilePath)) {
      return buildImageFromDockerfile(dockerfilePath);
    }
  }
  pullImageIfNeeded(config.image);
  return config.image;
}

// ---------------------------------------------------------------------------
// Docker command builder
// ---------------------------------------------------------------------------

export interface DockerSpawnOptions {
  config: DockerRunConfig;
  sourceAbs: string;
  workspaceRoot: string;
  runArgs: string[];
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

export const CONTAINER_WORKSPACE = "/jaiph/workspace";
const CONTAINER_WORKSPACE_RO = "/jaiph/workspace-ro";
const AGENT_ENV_PREFIXES = ["CURSOR_", "ANTHROPIC_", "CLAUDE_"] as const;

/**
 * Remap JAIPH_WORKSPACE and JAIPH_RUNS_DIR for use inside the Docker container.
 *
 * - JAIPH_WORKSPACE is always overridden to `/jaiph/workspace`.
 * - JAIPH_RUNS_DIR: relative values pass through unchanged; absolute values
 *   inside the host workspace are remapped to the equivalent container path;
 *   absolute values outside the host workspace cause a thrown error.
 */
export function remapDockerEnv(
  env: Record<string, string | undefined>,
  hostWorkspace: string,
): Record<string, string | undefined> {
  const out = { ...env };
  out.JAIPH_WORKSPACE = CONTAINER_WORKSPACE;

  const runsDir = out.JAIPH_RUNS_DIR;
  if (runsDir !== undefined && isAbsolute(runsDir)) {
    const absWorkspace = resolve(hostWorkspace);
    const absRunsDir = resolve(runsDir);
    const rel = relative(absWorkspace, absRunsDir);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `E_DOCKER_RUNS_DIR absolute JAIPH_RUNS_DIR "${runsDir}" is outside the host workspace "${absWorkspace}". ` +
        `In Docker mode, JAIPH_RUNS_DIR must be relative or inside the workspace.`,
      );
    }
    out.JAIPH_RUNS_DIR = `${CONTAINER_WORKSPACE}/${rel}`;
  }

  return out;
}

/**
 * Remap mount container paths for the overlay layout.
 * The primary workspace mount targets /jaiph/workspace-ro (read-only lower layer);
 * additional mounts under /jaiph/workspace become /jaiph/workspace-ro sub-paths.
 */
function overlayMountPath(containerPath: string): string {
  if (containerPath === "/jaiph/workspace" || containerPath.replace(/\/+$/, "") === "/jaiph/workspace") {
    return CONTAINER_WORKSPACE_RO;
  }
  if (containerPath.startsWith("/jaiph/workspace/")) {
    return CONTAINER_WORKSPACE_RO + containerPath.slice("/jaiph/workspace".length);
  }
  return containerPath;
}

/**
 * Build the `docker create` argument list.
 * Uses read-only workspace mount + fuse-overlayfs overlay (via /jaiph/overlay-run.sh).
 */
export function buildDockerArgs(opts: DockerSpawnOptions): string[] {
  const args: string[] = ["create"];

  // FUSE device for fuse-overlayfs CoW overlay
  args.push("--device", "/dev/fuse");

  // No -t flag: Docker's -t merges stderr into stdout, which breaks the
  // __JAIPH_EVENT__ stderr-only live contract between runtime and CLI.

  // Network
  if (opts.config.network !== "default") {
    args.push("--network", opts.config.network);
  }

  // Workspace mounts — all forced to read-only, remapped to /jaiph/workspace-ro
  for (const mount of opts.config.mounts) {
    const hostAbs = resolve(opts.workspaceRoot, mount.hostPath);
    const containerTarget = overlayMountPath(mount.containerPath);
    args.push("-v", `${hostAbs}:${containerTarget}:ro`);
  }

  // Environment variables — remap workspace-related paths for the container
  const containerEnv = remapDockerEnv(opts.env, opts.workspaceRoot);

  // Forward JAIPH_* env vars
  for (const [key, value] of Object.entries(containerEnv)) {
    if (key.startsWith("JAIPH_") && value !== undefined) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Forward agent-related env vars for Cursor/Claude authentication.
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value === undefined) continue;
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Working directory
  args.push("-w", CONTAINER_WORKSPACE);

  // Image
  args.push(opts.config.image);

  // Command: overlay wrapper runs fuse-overlayfs setup, then `jaiph run`
  const relSource = relative(opts.workspaceRoot, opts.sourceAbs);
  const containerSourcePath = `${CONTAINER_WORKSPACE}/${relSource}`;
  args.push(
    "/jaiph/overlay-run.sh",
    "jaiph", "run", containerSourcePath,
    ...opts.runArgs,
  );

  return args;
}

// ---------------------------------------------------------------------------
// Docker spawn with timeout + delta lifecycle
// ---------------------------------------------------------------------------

export interface DockerSpawnResult {
  child: ChildProcess;
  containerId: string;
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * Create and start the Docker container.
 * Lifecycle: docker create → docker start -a (attach stdout/stderr for event streaming).
 * After the container exits, the caller must invoke `applyDelta` then `cleanupContainer`.
 */
export function spawnDockerProcess(opts: DockerSpawnOptions): DockerSpawnResult {
  checkDockerAvailable();
  const resolvedImage = resolveImage(opts.config, opts.workspaceRoot);
  opts = { ...opts, config: { ...opts.config, image: resolvedImage } };

  const dockerArgs = buildDockerArgs(opts);

  // docker create → returns container ID on stdout
  const containerId = execSync(
    `docker ${dockerArgs.map(shellEscape).join(" ")}`,
    { encoding: "utf8", timeout: 30_000 },
  ).trim();

  // docker start -a: attach stdout/stderr for live event streaming
  const child = spawn("docker", ["start", "-a", containerId], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.workspaceRoot,
  });

  // Set up timeout
  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.config.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      try {
        execSync(`docker stop -t 5 ${containerId}`, { stdio: "ignore", timeout: 15_000 });
      } catch {
        // no-op
      }
    }, opts.config.timeout * 1000);
  }

  return { child, containerId, timeoutTimer };
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

export interface DeltaResult {
  runDir?: string;
  summaryFile?: string;
}

/**
 * Extract the delta from the container and apply it to the host workspace.
 * The container's /jaiph/delta/ directory contains:
 * - files/ — changed/added files (relative to workspace root)
 * - deletions.txt — one relative path per line for deleted files
 */
export function applyDelta(containerId: string, workspaceRoot: string): DeltaResult {
  const tmpDelta = mkdtempSync(join(tmpdir(), "jaiph-delta-"));
  try {
    // Copy delta from container to host temp dir
    try {
      execSync(`docker cp ${containerId}:/jaiph/delta/. ${tmpDelta}/`, {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      // Delta extraction failed — container may have crashed before overlay-run.sh
      // finished the delta phase. Return empty result.
      return {};
    }

    // Apply changed/added files
    const filesDir = join(tmpDelta, "files");
    if (existsSync(filesDir)) {
      copyDirToWorkspace(filesDir, workspaceRoot);
    }

    // Apply deletions
    const deletionsFile = join(tmpDelta, "deletions.txt");
    if (existsSync(deletionsFile)) {
      const deletions = readFileSync(deletionsFile, "utf8").split("\n").filter(Boolean);
      for (const rel of deletions) {
        const target = join(workspaceRoot, rel);
        try {
          rmSync(target, { force: true });
        } catch {
          // Best-effort
        }
      }
    }

    // Discover run_dir from applied artifacts
    return findRunArtifacts(workspaceRoot);
  } finally {
    rmSync(tmpDelta, { recursive: true, force: true });
  }
}

function copyDirToWorkspace(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyDirToWorkspace(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Find the most recent run directory under .jaiph/runs/.
 * Run dirs follow the pattern: .jaiph/runs/<date>/<time>-<workflow>/
 */
function findRunArtifacts(workspaceRoot: string): DeltaResult {
  const runsRoot = join(workspaceRoot, ".jaiph", "runs");
  if (!existsSync(runsRoot)) return {};

  let latestDir: string | undefined;
  let latestMtime = 0;

  try {
    for (const dateDir of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!dateDir.isDirectory()) continue;
      const datePath = join(runsRoot, dateDir.name);
      for (const runDir of readdirSync(datePath, { withFileTypes: true })) {
        if (!runDir.isDirectory()) continue;
        const runPath = join(datePath, runDir.name);
        const stat = statSync(runPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestDir = runPath;
        }
      }
    }
  } catch {
    return {};
  }

  if (!latestDir) return {};

  const summaryFile = join(latestDir, "run_summary.jsonl");
  return {
    runDir: latestDir,
    summaryFile: existsSync(summaryFile) ? summaryFile : undefined,
  };
}

/**
 * Clean up the Docker container after execution.
 */
export function cleanupDocker(result: DockerSpawnResult): void {
  if (result.timeoutTimer) {
    clearTimeout(result.timeoutTimer);
  }
  try {
    execSync(`docker rm -f ${result.containerId}`, { stdio: "ignore", timeout: 15_000 });
  } catch {
    // Best-effort cleanup
  }
}
