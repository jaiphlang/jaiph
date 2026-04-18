import { execFileSync, execSync, spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Validate mount list: exactly one mount must target `/jaiph/workspace`.
 * Also rejects dangerous host paths.
 */
export function validateMounts(mounts: MountSpec[], workspaceRoot?: string): void {
  const workspaceMounts = mounts.filter(
    (m) => m.containerPath === "/jaiph/workspace" || m.containerPath.replace(/\/+$/, "") === "/jaiph/workspace",
  );
  if (workspaceMounts.length === 0) {
    throw new Error("E_VALIDATE exactly one mount must target /jaiph/workspace");
  }
  if (workspaceMounts.length > 1) {
    throw new Error("E_VALIDATE exactly one mount must target /jaiph/workspace, found multiple");
  }
  for (const mount of mounts) {
    const hostAbs = workspaceRoot ? resolve(workspaceRoot, mount.hostPath) : resolve(mount.hostPath);
    validateMountHostPath(hostAbs);
  }
}

// ---------------------------------------------------------------------------
// Config resolution (env > in-file > defaults)
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

const DEFAULTS: DockerRunConfig = {
  enabled: false,
  image: `${GHCR_IMAGE_REPO}:${resolveDefaultImageTag()}`,
  imageExplicit: false,
  network: "default",
  timeout: 300,
  mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
};

/**
 * Resolve effective Docker config.
 * Precedence: env vars (`JAIPH_DOCKER_*`) > in-file RuntimeConfig > CI/unsafe default rule.
 *
 * Default rule (when no explicit override is set):
 *  - `CI=true` or `JAIPH_UNSAFE=true` → Docker off
 *  - Otherwise → Docker on
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  // enabled: env JAIPH_DOCKER_ENABLED > in-file > CI/unsafe default rule
  let enabled: boolean;
  if (env.JAIPH_DOCKER_ENABLED !== undefined) {
    enabled = env.JAIPH_DOCKER_ENABLED === "true";
  } else if (inFile?.dockerEnabled !== undefined) {
    enabled = inFile.dockerEnabled;
  } else {
    // Default: Docker on unless CI or unsafe mode is active
    const isCI = env.CI === "true";
    const isUnsafe = env.JAIPH_UNSAFE === "true";
    enabled = !(isCI || isUnsafe);
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
 * Resolve the Docker image to use.
 *
 * When the image was not explicitly configured (`imageExplicit === false`),
 * checks for `.jaiph/Dockerfile` in the workspace root. If present, builds
 * from it and verifies jaiph is present. Otherwise uses the configured
 * (default) image — the official GHCR runtime image — and pulls if needed.
 *
 * All images are verified to contain `jaiph` before use. If the image
 * lacks jaiph, the run fails immediately with guidance.
 */
export function resolveImage(config: DockerRunConfig, workspaceRoot: string): string {
  let image = config.image;
  if (!config.imageExplicit) {
    const dockerfilePath = join(workspaceRoot, ".jaiph", "Dockerfile");
    if (existsSync(dockerfilePath)) {
      image = buildImageFromDockerfile(dockerfilePath);
    } else {
      pullImageIfNeeded(image);
    }
  } else {
    pullImageIfNeeded(image);
  }
  verifyImageHasJaiph(image);
  return image;
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
mkdir -p "$UPPER" "$WORK" "$MERGED"
overlay_ok=0
overlay_reason=""
if command -v fuse-overlayfs >/dev/null 2>&1 && [ -e /dev/fuse ]; then
  if fuse-overlayfs -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK" "$MERGED" 2>/tmp/jaiph-fuse-overlay.err; then
    probe_path="$(mktemp "$MERGED/.jaiph-overlay-probe.XXXXXX" 2>/dev/null || true)"
    if [ -n "$probe_path" ]; then
      rm -f "$probe_path"
      overlay_ok=1
    else
      overlay_reason="fuse-overlayfs mounted but workspace is still not writable"
    fi
  else
    overlay_reason="$(tr '\n' ' ' </tmp/jaiph-fuse-overlay.err | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
  fi
else
  overlay_reason="fuse-overlayfs unavailable or /dev/fuse missing"
fi
if [ "$overlay_ok" -ne 1 ]; then
  if command -v rsync >/dev/null 2>&1; then
    if rsync -a --delete "$LOWER"/ "$MERGED"/ 2>/tmp/jaiph-workspace-copy.err; then
      printf 'jaiph docker: workspace overlay unavailable; using copy fallback at /jaiph/workspace' >&2
      if [ -n "$overlay_reason" ]; then
        printf ' (%s)' "$overlay_reason" >&2
      fi
      printf '\n' >&2
      overlay_ok=1
    else
      copy_reason="$(tr '\n' ' ' </tmp/jaiph-workspace-copy.err | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
      printf 'jaiph docker: workspace overlay unavailable and copy fallback failed; /jaiph/workspace may be incomplete' >&2
      if [ -n "$overlay_reason" ]; then
        printf ' (%s)' "$overlay_reason" >&2
      fi
      if [ -n "$copy_reason" ]; then
        printf ' [copy fallback: %s]' "$copy_reason" >&2
      fi
      printf '\n' >&2
    fi
  else
    if cp -a "$LOWER"/. "$MERGED"/ 2>/tmp/jaiph-workspace-cp.err; then
      printf 'jaiph docker: workspace overlay unavailable; using cp fallback at /jaiph/workspace' >&2
      if [ -n "$overlay_reason" ]; then
        printf ' (%s)' "$overlay_reason" >&2
      fi
      printf '\n' >&2
      overlay_ok=1
    else
      cp_reason="$(tr '\n' ' ' </tmp/jaiph-workspace-cp.err | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
      printf 'jaiph docker: workspace overlay unavailable and copy fallbacks are unavailable; /jaiph/workspace may be incomplete' >&2
      if [ -n "$overlay_reason" ]; then
        printf ' (%s)' "$overlay_reason" >&2
      fi
      if [ -n "$cp_reason" ]; then
        printf ' [cp fallback: %s]' "$cp_reason" >&2
      fi
      printf '\n' >&2
    fi
  fi
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
 *  1. workspace → /jaiph/workspace-ro:ro  (overlay lower layer / copy source)
 *  2. sandboxRunDir → /jaiph/run:rw       (single run artifacts)
 *
 * The image already contains a writable `/jaiph/workspace` directory.
 * `overlay-run.sh` mounts `fuse-overlayfs` there when available; otherwise it
 * copies the lower layer into that directory as a writable fallback. `/jaiph/run`
 * is outside the overlay, so run artifacts still persist to the host mount.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 */
export function buildDockerArgs(opts: DockerSpawnOptions, overlayScriptPath: string): string[] {
  const args: string[] = ["run", "--rm"];

  // Least-privilege: drop all capabilities, re-add only SYS_ADMIN for fuse-overlayfs
  args.push("--cap-drop", "ALL");
  args.push("--cap-add", "SYS_ADMIN");
  args.push("--security-opt", "no-new-privileges");

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

  // Workspace inputs: mounted only at the overlay lower-layer path.
  for (const mount of opts.config.mounts) {
    const hostAbs = resolve(opts.workspaceRoot, mount.hostPath);
    validateMountHostPath(hostAbs);
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
    if (isEnvDenied(key)) continue;
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

// ---------------------------------------------------------------------------
// Workspace patch export (Docker teardown)
// ---------------------------------------------------------------------------

/**
 * Export a git diff of workspace changes to a patch file.
 * Used during Docker run teardown to capture sandbox-local modifications.
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
    process.stderr.write(`jaiph docker: workspace patch export failed: ${msg}\n`);
    return false;
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

