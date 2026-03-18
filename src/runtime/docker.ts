import { execSync, spawn, ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
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
  image: "ubuntu:24.04",
  network: "default",
  timeout: 300,
  mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
};

/**
 * Resolve effective Docker config.
 * Precedence: env vars (`JAIPH_DOCKER_*`) > in-file RuntimeConfig > defaults.
 * CI=true disables Docker by default unless in-file override is set.
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  const ciDefault = env.CI === "true";

  // enabled: env > in-file > (CI default | false)
  let enabled: boolean;
  if (env.JAIPH_DOCKER_ENABLED !== undefined) {
    enabled = env.JAIPH_DOCKER_ENABLED === "true";
  } else if (inFile?.dockerEnabled !== undefined) {
    enabled = inFile.dockerEnabled;
  } else {
    enabled = ciDefault ? false : DEFAULTS.enabled;
  }

  // image: env > in-file > default
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

  return { enabled, image, network, timeout, mounts };
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
// Generated directory setup
// ---------------------------------------------------------------------------

/**
 * Create a temp directory with the transpiled script and jaiph_stdlib.sh,
 * to be mounted read-only at /jaiph/generated/ inside the container.
 */
export function prepareGeneratedDir(builtScriptPath: string, stdlibPath: string): string {
  const generatedDir = mkdtempSync(join(tmpdir(), "jaiph-docker-gen-"));
  copyFileSync(builtScriptPath, join(generatedDir, basename(builtScriptPath)));

  // Copy jaiph_stdlib.sh
  copyFileSync(stdlibPath, join(generatedDir, "jaiph_stdlib.sh"));

  // Copy runtime modules alongside stdlib
  const stdlibDir = dirname(stdlibPath);
  const runtimeSrcDir = join(stdlibDir, "runtime");
  if (existsSync(runtimeSrcDir)) {
    const runtimeDestDir = join(generatedDir, "runtime");
    mkdirSync(runtimeDestDir, { recursive: true });
    for (const mod of ["events.sh", "test-mode.sh", "steps.sh", "prompt.sh", "sandbox.sh"]) {
      const src = join(runtimeSrcDir, mod);
      if (existsSync(src)) {
        copyFileSync(src, join(runtimeDestDir, mod));
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
  workspaceRoot: string;
  wrapperCommand: string;
  metaFile: string;
  workflowSymbol: string;
  runArgs: string[];
  env: Record<string, string | undefined>;
  isTTY: boolean;
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

  // Environment variables
  args.push("-e", `JAIPH_STDLIB=/jaiph/generated/jaiph_stdlib.sh`);

  // Forward JAIPH_* env vars (except JAIPH_STDLIB which we override)
  for (const [key, value] of Object.entries(opts.env)) {
    if (key.startsWith("JAIPH_") && key !== "JAIPH_STDLIB" && value !== undefined) {
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
  pullImageIfNeeded(opts.config.image);

  const generatedDir = prepareGeneratedDir(opts.builtScriptPath, opts.stdlibPath);
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
