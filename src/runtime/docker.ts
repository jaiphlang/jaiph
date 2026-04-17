import { execFileSync, execSync, spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
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
const AUTO_RUNTIME_IMAGE_REPO = "jaiph-runtime-auto";

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

function installedPackageRoot(): string {
  return resolve(__dirname, "..", "..", "..");
}

function autoRuntimeImageTag(baseImage: string, packageRoot: string): string {
  const packageJsonPath = join(packageRoot, "package.json");
  const cliPath = join(packageRoot, "dist", "src", "cli.js");
  const packageStamp = existsSync(packageJsonPath) ? statSync(packageJsonPath).mtimeMs : 0;
  const cliStamp = existsSync(cliPath) ? statSync(cliPath).mtimeMs : 0;
  const digest = createHash("sha256")
    .update(`${baseImage}|${resolve(packageRoot)}|${packageStamp}|${cliStamp}`)
    .digest("hex")
    .slice(0, 12);
  return `${AUTO_RUNTIME_IMAGE_REPO}:${digest}`;
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

function buildRuntimeImageFromLocalPackage(baseImage: string, packageRoot: string, tag: string): string {
  const contextDir = mkdtempSync(join(tmpdir(), "jaiph-runtime-image-"));
  try {
    const tarballName = execFileSync(
      "npm",
      ["pack", packageRoot, "--silent", "--pack-destination", contextDir],
      { cwd: packageRoot, encoding: "utf8", timeout: 300_000 },
    ).trim().split(/\r?\n/).pop()?.trim();
    if (!tarballName) {
      throw new Error("npm pack produced no tarball");
    }
    writeFileSync(
      join(contextDir, "Dockerfile"),
      [
        `FROM ${baseImage}`,
        `COPY ${tarballName} /tmp/${tarballName}`,
        `RUN npm install -g /tmp/${tarballName} && rm -f /tmp/${tarballName}`,
        "",
      ].join("\n"),
    );
    execFileSync("docker", ["build", "-t", tag, contextDir], {
      stdio: "inherit",
      timeout: 600_000,
    });
    return tag;
  } catch {
    throw new Error(`E_DOCKER_BUILD failed to build runtime image from base "${baseImage}"`);
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

function ensureImageHasJaiph(baseImage: string): string {
  pullImageIfNeeded(baseImage);
  if (imageHasJaiph(baseImage)) {
    return baseImage;
  }
  const packageRoot = installedPackageRoot();
  const tag = autoRuntimeImageTag(baseImage, packageRoot);
  try {
    execSync(`docker image inspect ${tag}`, { stdio: "ignore", timeout: 30_000 });
    return tag;
  } catch {
    return buildRuntimeImageFromLocalPackage(baseImage, packageRoot, tag);
  }
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
  let baseImage = config.image;
  if (!config.imageExplicit) {
    const dockerfilePath = join(workspaceRoot, ".jaiph", "Dockerfile");
    if (existsSync(dockerfilePath)) {
      baseImage = buildImageFromDockerfile(dockerfilePath);
    }
  }
  return ensureImageHasJaiph(baseImage);
}

// ---------------------------------------------------------------------------
// Overlay entrypoint script (written to temp file, mounted into container)
// ---------------------------------------------------------------------------

const OVERLAY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
LOWER=/jaiph/workspace-ro
UPPER=/tmp/overlay-upper
WORK=/tmp/overlay-work
MERGED=/jaiph/workspace
mkdir -p "$UPPER" "$WORK"
if command -v fuse-overlayfs >/dev/null 2>&1 && [ -e /dev/fuse ]; then
  fuse-overlayfs -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK" "$MERGED" 2>/dev/null || true
fi
exec "$@"
`;

/**
 * Write overlay-run.sh to a temp file and return its path.
 * Mounted read-only at /jaiph/overlay-run.sh inside the container.
 */
export function writeOverlayScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-overlay-"));
  const scriptPath = join(dir, "overlay-run.sh");
  writeFileSync(scriptPath, OVERLAY_SCRIPT, { mode: 0o755 });
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Docker command builder
// ---------------------------------------------------------------------------

export interface DockerSpawnOptions {
  config: DockerRunConfig;
  sourceAbs: string;
  workspaceRoot: string;
  /** Host directory mounted at /jaiph/run:rw for this single run's artifacts. */
  sandboxRunDir: string;
  runArgs: string[];
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

export const CONTAINER_WORKSPACE = "/jaiph/workspace";
export const CONTAINER_RUN_DIR = "/jaiph/run";
const AGENT_ENV_PREFIXES = ["CURSOR_", "ANTHROPIC_", "CLAUDE_"] as const;

/** Resolve the host run-artifacts root for Docker-backed runs. */
export function resolveDockerHostRunsRoot(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
): string {
  const configured = env.JAIPH_RUNS_DIR;
  if (!configured || configured.length === 0) {
    return join(workspaceRoot, ".jaiph", "runs");
  }
  if (!configured.startsWith("/")) {
    return join(workspaceRoot, configured);
  }
  const resolved = resolve(configured);
  const workspaceAbs = resolve(workspaceRoot);
  if (resolved === workspaceAbs || !resolved.startsWith(`${workspaceAbs}/`)) {
    throw new Error(
      `E_DOCKER_RUNS_DIR unsupported: absolute JAIPH_RUNS_DIR must be within the workspace when using Docker`,
    );
  }
  return resolved;
}

/**
 * Remap environment variables for use inside the Docker container.
 * JAIPH_WORKSPACE → /jaiph/workspace, JAIPH_RUNS_DIR → /jaiph/run.
 */
export function remapDockerEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  out.JAIPH_WORKSPACE = CONTAINER_WORKSPACE;
  out.JAIPH_RUNS_DIR = CONTAINER_RUN_DIR;
  return out;
}

/** Remap a container mount path to the overlay lower-layer equivalent. */
export function overlayMountPath(containerPath: string): string {
  if (containerPath === CONTAINER_WORKSPACE || containerPath === CONTAINER_WORKSPACE + "/") {
    return `${CONTAINER_WORKSPACE}-ro`;
  }
  if (containerPath.startsWith(CONTAINER_WORKSPACE + "/")) {
    return `${CONTAINER_WORKSPACE}-ro${containerPath.slice(CONTAINER_WORKSPACE.length)}`;
  }
  return containerPath;
}

/**
 * Build the `docker run --rm` argument list.
 *
 * Mounts:
 *  1. workspace → /jaiph/workspace:ro  (fallback when overlay absent)
 *  2. workspace → /jaiph/workspace-ro:ro  (overlay lower layer)
 *  3. sandboxRunDir → /jaiph/run:rw  (single run artifacts)
 *
 * overlay-run.sh (baked in image) creates a fuse-overlayfs CoW at
 * /jaiph/workspace using -ro as lower.  /jaiph/run is outside the overlay
 * so writes go directly to the host mount — no symlink needed.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 */
export function buildDockerArgs(opts: DockerSpawnOptions, overlayScriptPath: string): string[] {
  const args: string[] = ["run", "--rm"];

  args.push("--device", "/dev/fuse");

  if (process.platform === "linux") {
    try {
      const uid = execSync("id -u", { encoding: "utf8" }).trim();
      const gid = execSync("id -g", { encoding: "utf8" }).trim();
      args.push("--user", `${uid}:${gid}`);
    } catch {
      // Fall through without --user
    }
  }

  if (opts.config.network !== "default") {
    args.push("--network", opts.config.network);
  }

  // Workspace: ro at primary path (fallback) + overlay lower layer path
  for (const mount of opts.config.mounts) {
    const hostAbs = resolve(opts.workspaceRoot, mount.hostPath);
    args.push("-v", `${hostAbs}:${mount.containerPath}:ro`);
    args.push("-v", `${hostAbs}:${overlayMountPath(mount.containerPath)}:ro`);
  }

  // Single run directory: rw mount outside the overlay
  args.push("-v", `${opts.sandboxRunDir}:${CONTAINER_RUN_DIR}:rw`);

  // Overlay entrypoint script (runtime-generated, mounted ro)
  args.push("-v", `${overlayScriptPath}:/jaiph/overlay-run.sh:ro`);

  // Environment
  const containerEnv = remapDockerEnv(opts.env);

  for (const [key, value] of Object.entries(containerEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("JAIPH_") && !key.startsWith("JAIPH_DOCKER_")) {
      args.push("-e", `${key}=${value}`);
    }
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push("-w", CONTAINER_WORKSPACE);
  args.push(opts.config.image);

  // Command: overlay wrapper → jaiph run --raw
  const relSource = relative(opts.workspaceRoot, opts.sourceAbs);
  args.push(
    "/jaiph/overlay-run.sh",
    "jaiph", "run", "--raw",
    `${CONTAINER_WORKSPACE}/${relSource}`,
    ...opts.runArgs,
  );

  return args;
}

// ---------------------------------------------------------------------------
// Docker spawn with timeout + delta lifecycle
// ---------------------------------------------------------------------------

export interface DockerSpawnResult {
  child: ChildProcess;
  /** Host directory mounted at /jaiph/run — scan for artifacts after exit. */
  sandboxRunDir: string;
  /** Temp directory containing overlay-run.sh — cleaned up after exit. */
  overlayScriptDir: string;
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * Spawn the Docker container.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 * Events flow via stderr; stdout carries workflow output.
 */
export function spawnDockerProcess(opts: DockerSpawnOptions): DockerSpawnResult {
  checkDockerAvailable();
  const resolvedImage = resolveImage(opts.config, opts.workspaceRoot);
  opts = { ...opts, config: { ...opts.config, image: resolvedImage } };

  mkdirSync(opts.sandboxRunDir, { recursive: true });
  const overlayScriptPath = writeOverlayScript();
  const overlayScriptDir = dirname(overlayScriptPath);
  const dockerArgs = buildDockerArgs(opts, overlayScriptPath);

  const child = spawn("docker", dockerArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.workspaceRoot,
    env: opts.env,
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.config.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // no-op
        }
      }, 5000);
    }, opts.config.timeout * 1000);
  }

  return { child, sandboxRunDir: opts.sandboxRunDir, overlayScriptDir, timeoutTimer };
}

/**
 * Clean up Docker resources after execution.
 */
export function cleanupDocker(result: DockerSpawnResult): void {
  if (result.timeoutTimer) {
    clearTimeout(result.timeoutTimer);
  }
  try {
    rmSync(result.overlayScriptDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

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

