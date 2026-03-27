import { execSync, spawn, ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname, relative, isAbsolute } from "node:path";
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
// Generated directory setup
// ---------------------------------------------------------------------------

function copyExecutableScriptsDir(scriptsSrc: string, generatedDir: string): void {
  if (!existsSync(scriptsSrc)) return;
  const scriptsDest = join(generatedDir, "scripts");
  mkdirSync(scriptsDest, { recursive: true });
  for (const name of readdirSync(scriptsSrc)) {
    const sf = join(scriptsSrc, name);
    if (statSync(sf).isFile()) {
      copyFileSync(sf, join(scriptsDest, name));
    }
  }
}

/**
 * Create a temp directory with the transpiled script(s) and jaiph_stdlib.sh,
 * to be mounted read-only at /jaiph/generated/ inside the container.
 * When buildOutDir is set, copies all *.sh from that directory (for workflows with imports).
 */
export function prepareGeneratedDir(
  builtScriptPath: string,
  stdlibPath: string,
  buildOutDir?: string,
): string {
  const generatedDir = mkdtempSync(join(tmpdir(), "jaiph-docker-gen-"));
  if (buildOutDir && existsSync(buildOutDir)) {
    for (const entry of readdirSync(buildOutDir, { recursive: true })) {
      const rel = typeof entry === "string" ? entry : "";
      if (!rel.endsWith(".sh")) continue;
      const full = join(buildOutDir, rel);
      if (statSync(full).isFile()) {
        const dest = join(generatedDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(full, dest);
      }
    }
    copyExecutableScriptsDir(join(buildOutDir, "scripts"), generatedDir);
  } else {
    copyFileSync(builtScriptPath, join(generatedDir, basename(builtScriptPath)));
    copyExecutableScriptsDir(join(dirname(builtScriptPath), "scripts"), generatedDir);
  }

  // Copy jaiph_stdlib.sh
  copyFileSync(stdlibPath, join(generatedDir, "jaiph_stdlib.sh"));

  // Copy runtime modules alongside stdlib
  const stdlibDir = dirname(stdlibPath);
  const runtimeSrcDir = join(stdlibDir, "runtime");
  if (existsSync(runtimeSrcDir)) {
    const runtimeDestDir = join(generatedDir, "runtime");
    mkdirSync(runtimeDestDir, { recursive: true });
    for (const mod of ["events.sh", "test-mode.sh", "steps.sh", "inbox.sh", "prompt.sh", "sandbox.sh"]) {
      const src = join(runtimeSrcDir, mod);
      if (existsSync(src)) {
        copyFileSync(src, join(runtimeDestDir, mod));
      }
    }
    const kernelSrc = join(runtimeSrcDir, "kernel");
    if (existsSync(kernelSrc)) {
      const kernelDest = join(runtimeDestDir, "kernel");
      mkdirSync(kernelDest, { recursive: true });
      for (const name of readdirSync(kernelSrc)) {
        if (!name.endsWith(".js")) continue;
        const kf = join(kernelSrc, name);
        if (statSync(kf).isFile()) {
          copyFileSync(kf, join(kernelDest, name));
        }
      }
    }
  }

  return generatedDir;
}

// ---------------------------------------------------------------------------
// Docker command builder
// ---------------------------------------------------------------------------

export interface DockerSpawnOptions {
  config: DockerRunConfig;
  builtScriptPath: string;
  stdlibPath: string;
  /** When set, all *.sh under this dir are copied into generated (for workflows with imports). */
  buildOutDir?: string;
  workspaceRoot: string;
  wrapperCommand: string;
  metaFile: string;
  workflowSymbol: string;
  runArgs: string[];
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

const CONTAINER_WORKSPACE = "/jaiph/workspace";
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
 * Build the full `docker run` argument list.
 */
export function buildDockerArgs(opts: DockerSpawnOptions, generatedDir: string): string[] {
  const args: string[] = ["run", "--rm"];

  // TTY passthrough
  if (opts.isTTY) {
    args.push("-t");
  }

  // UID/GID mapping on Linux
  if (process.platform === "linux") {
    try {
      const uid = execSync("id -u", { encoding: "utf8" }).trim();
      const gid = execSync("id -g", { encoding: "utf8" }).trim();
      args.push("--user", `${uid}:${gid}`);
    } catch {
      // Fall through without --user
    }
  }

  // Network
  if (opts.config.network !== "default") {
    args.push("--network", opts.config.network);
  }

  // Mount generated dir read-only at /jaiph/generated/
  args.push("-v", `${generatedDir}:/jaiph/generated:ro`);

  // User-specified mounts
  for (const mount of opts.config.mounts) {
    const hostAbs = resolve(opts.workspaceRoot, mount.hostPath);
    args.push("-v", `${hostAbs}:${mount.containerPath}:${mount.mode}`);
  }

  // Mount meta file directory so the wrapper can write the meta file
  const metaDir = dirname(opts.metaFile);
  const metaBase = basename(opts.metaFile);
  args.push("-v", `${metaDir}:${metaDir}:rw`);

  // Environment variables — remap workspace-related paths for the container
  const containerEnv = remapDockerEnv(opts.env, opts.workspaceRoot);
  args.push("-e", `JAIPH_STDLIB=/jaiph/generated/jaiph_stdlib.sh`);

  // Forward JAIPH_* env vars (except JAIPH_STDLIB which we override)
  for (const [key, value] of Object.entries(containerEnv)) {
    if (key.startsWith("JAIPH_") && key !== "JAIPH_STDLIB" && value !== undefined) {
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
  args.push("-w", "/jaiph/workspace");

  // Image
  args.push(opts.config.image);

  // Command: bash -c <wrapper> jaiph-run <meta> <script> <symbol> [args...]
  const scriptName = basename(opts.builtScriptPath);
  args.push(
    "bash", "-c", opts.wrapperCommand, "jaiph-run",
    opts.metaFile,
    `/jaiph/generated/${scriptName}`,
    opts.workflowSymbol,
    ...opts.runArgs,
  );

  return args;
}

// ---------------------------------------------------------------------------
// Docker spawn with timeout
// ---------------------------------------------------------------------------

export interface DockerSpawnResult {
  child: ChildProcess;
  generatedDir: string;
  timeoutTimer?: NodeJS.Timeout;
  containerId?: string;
}

/**
 * Spawn the Docker container and set up timeout handling.
 */
export function spawnDockerProcess(opts: DockerSpawnOptions): DockerSpawnResult {
  checkDockerAvailable();
  const resolvedImage = resolveImage(opts.config, opts.workspaceRoot);
  opts = { ...opts, config: { ...opts.config, image: resolvedImage } };

  const generatedDir = prepareGeneratedDir(
    opts.builtScriptPath,
    opts.stdlibPath,
    opts.buildOutDir,
  );
  const dockerArgs = buildDockerArgs(opts, generatedDir);

  const child = spawn("docker", dockerArgs, {
    stdio: "pipe",
    cwd: opts.workspaceRoot,
    env: opts.env,
  });

  // Set up timeout
  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.config.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      // Kill the container on timeout
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      // Force kill after a grace period
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // no-op
        }
      }, 5000);
    }, opts.config.timeout * 1000);
  }

  return { child, generatedDir, timeoutTimer };
}

/**
 * Clean up Docker resources after execution.
 */
export function cleanupDocker(result: DockerSpawnResult): void {
  if (result.timeoutTimer) {
    clearTimeout(result.timeoutTimer);
  }
  try {
    rmSync(result.generatedDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
