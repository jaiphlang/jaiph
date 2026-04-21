import { execFileSync, execSync, spawn, spawnSync, ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
 * Precedence: env vars (`JAIPH_DOCKER_*`) > in-file RuntimeConfig > unsafe default rule.
 *
 * Default rule (when no explicit override is set):
 *  - `JAIPH_UNSAFE=true` → Docker off (explicit "run on host" escape hatch)
 *  - Otherwise → Docker on (including in CI; CI=true alone no longer disables Docker)
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  // enabled: env JAIPH_DOCKER_ENABLED > in-file > unsafe default rule
  let enabled: boolean;
  if (env.JAIPH_DOCKER_ENABLED !== undefined) {
    enabled = env.JAIPH_DOCKER_ENABLED === "true";
  } else if (inFile?.dockerEnabled !== undefined) {
    enabled = inFile.dockerEnabled;
  } else {
    // Default: Docker on unless the user explicitly opts out via JAIPH_UNSAFE.
    // CI=true is intentionally not consulted — CI runs (incl. landing-page e2e
    // and docs sample tests) should exercise the same sandbox path users do.
    enabled = env.JAIPH_UNSAFE !== "true";
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
 * Always uses `config.image` (from env, in-file `runtime.docker_image`, or the
 * default `ghcr.io/jaiphlang/jaiph-runtime:<version>`). Pulls from the registry
 * if the image is not present locally. To use a custom image, build/push it
 * yourself and set `runtime.docker_image` or `JAIPH_DOCKER_IMAGE`.
 *
 * Verifies that `jaiph` exists in the image before use (`E_DOCKER_NO_JAIPH`).
 */
export function resolveImage(config: DockerRunConfig): string {
  const image = config.image;
  pullImageIfNeeded(image);
  verifyImageHasJaiph(image);
  return image;
}

// ---------------------------------------------------------------------------
// Overlay entrypoint script (written to temp file, mounted into container)
// ---------------------------------------------------------------------------

/**
 * Container-side fuse-overlayfs setup.
 *
 * Used only when the host selects "overlay" sandbox mode (i.e. /dev/fuse exists
 * on the host). Mounts a fuse-overlayfs union at /jaiph/workspace (lower = the
 * host workspace bind-mounted ro at /jaiph/workspace-ro, upper = tmpfs) and
 * execs the command. If fuse-overlayfs is missing or fails, the script exits
 * with a clear error code; the host-copy mode is the documented fallback users
 * opt into (e.g. when fuse is unavailable on macOS Docker Desktop).
 *
 * No in-container rsync/cp fallback. That path was the slow one — we replaced
 * it with a host-side clone (see `cloneWorkspaceForSandbox`).
 */
const OVERLAY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
LOWER=/jaiph/workspace-ro
UPPER=/tmp/overlay-upper
WORK=/tmp/overlay-work
MERGED=/jaiph/workspace
RUN_DIR=/jaiph/run
mkdir -p "$UPPER" "$WORK" "$MERGED"

if ! command -v fuse-overlayfs >/dev/null 2>&1; then
  printf 'E_DOCKER_OVERLAY fuse-overlayfs not found in image; install it or set JAIPH_DOCKER_NO_OVERLAY=1 on the host to use the copy sandbox path\\n' >&2
  exit 78
fi
if [ ! -e /dev/fuse ]; then
  printf 'E_DOCKER_OVERLAY /dev/fuse not present in container; pass --device /dev/fuse or set JAIPH_DOCKER_NO_OVERLAY=1 to use the copy sandbox path\\n' >&2
  exit 78
fi
if ! fuse-overlayfs -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK,allow_other" "$MERGED" 2>/tmp/jaiph-fuse-overlay.err; then
  reason="$(tr '\\n' ' ' </tmp/jaiph-fuse-overlay.err | sed 's/[[:space:]]\\+/ /g; s/^ //; s/ $//')"
  printf 'E_DOCKER_OVERLAY fuse-overlayfs mount failed: %s\\n' "$reason" >&2
  exit 78
fi

cd "$MERGED"

# Drop to host UID/GID after mounting overlay as root.
if [ -n "\${JAIPH_HOST_UID:-}" ] && [ -n "\${JAIPH_HOST_GID:-}" ] && command -v setpriv >/dev/null 2>&1; then
  chown "$JAIPH_HOST_UID:$JAIPH_HOST_GID" "$RUN_DIR" 2>/dev/null || true
  exec setpriv --reuid="$JAIPH_HOST_UID" --regid="$JAIPH_HOST_GID" --clear-groups -- "$@"
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
// Sandbox mode selection + host-side workspace clone
// ---------------------------------------------------------------------------

/** Selected sandbox primitive for a Docker run. */
export type SandboxMode = "overlay" | "copy";

/**
 * Choose the sandbox mode for the upcoming run.
 *
 * Heuristic: presence of `/dev/fuse` on the host is a strong proxy for
 * fuse-overlayfs viability inside the container. Linux dev/CI hosts typically
 * have it; macOS Docker Desktop typically doesn't expose it. Override with
 * `JAIPH_DOCKER_NO_OVERLAY=1` to force the host-copy path.
 */
export function selectSandboxMode(env: Record<string, string | undefined>): SandboxMode {
  if (env.JAIPH_DOCKER_NO_OVERLAY === "1" || env.JAIPH_DOCKER_NO_OVERLAY === "true") {
    return "copy";
  }
  return existsSync("/dev/fuse") ? "overlay" : "copy";
}

/** Run `cp` with the given flags. Returns true on success. */
function tryCp(flags: string[], src: string, dst: string): { ok: boolean; stderr: string } {
  const r = spawnSync("cp", [...flags, src, dst], { stdio: ["ignore", "ignore", "pipe"] });
  return { ok: r.status === 0, stderr: r.stderr?.toString() ?? "" };
}

/**
 * Copy a single top-level entry into the sandbox workspace.
 *
 * On macOS, prefers `cp -cR` (APFS clonefile, O(1) per file). On any
 * platform/filesystem where clonefile fails (or on Linux where BSD `-c` isn't
 * supported), falls back to plain `cp -R` and notes the fallback for the caller
 * to surface as a one-time warning.
 */
function copyEntryWithCloneFallback(
  src: string,
  dst: string,
  state: { cloneAttempted: boolean; cloneSupported: boolean; firstFallbackReason: string | null },
): void {
  if (process.platform === "darwin") {
    if (!state.cloneAttempted) {
      state.cloneAttempted = true;
      const r = tryCp(["-cR"], src, dst);
      if (r.ok) {
        state.cloneSupported = true;
        return;
      }
      state.firstFallbackReason = r.stderr.trim().split("\n")[0] || "cp -cR failed";
      const fb = tryCp(["-pR"], src, dst);
      if (!fb.ok) {
        throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${fb.stderr.trim()}`);
      }
      return;
    }
    if (state.cloneSupported) {
      const r = tryCp(["-cR"], src, dst);
      if (r.ok) return;
    }
    const fb = tryCp(["-pR"], src, dst);
    if (!fb.ok) {
      throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${fb.stderr.trim()}`);
    }
    return;
  }
  const r = tryCp(["-pR"], src, dst);
  if (!r.ok) {
    throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${r.stderr.trim()}`);
  }
}

/**
 * Clone the host workspace into a sandbox directory.
 *
 * - macOS: tries `cp -cR` (APFS clonefile, O(1)); on failure, falls back to
 *   `cp -pR` (real copy) with a single stderr warning noting the reason.
 * - Linux/other: uses `cp -pR` directly. The slow case (no fuse-overlayfs +
 *   non-COW filesystem) is documented; users on those hosts pay the copy cost.
 *
 * Excludes `.jaiph/runs` (mounted separately at `/jaiph/run`) and `.git/objects`
 * is intentionally NOT excluded — workflows may need git history.
 */
export function cloneWorkspaceForSandbox(
  srcRoot: string,
  dstRoot: string,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): void {
  mkdirSync(dstRoot, { recursive: true });
  const state = { cloneAttempted: false, cloneSupported: false, firstFallbackReason: null as string | null };

  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (entry.name === ".jaiph") continue;
    copyEntryWithCloneFallback(join(srcRoot, entry.name), join(dstRoot, entry.name), state);
  }

  const jaiphSrc = join(srcRoot, ".jaiph");
  if (existsSync(jaiphSrc)) {
    const jaiphDst = join(dstRoot, ".jaiph");
    mkdirSync(jaiphDst, { recursive: true });
    for (const entry of readdirSync(jaiphSrc, { withFileTypes: true })) {
      if (entry.name === "runs") continue;
      copyEntryWithCloneFallback(join(jaiphSrc, entry.name), join(jaiphDst, entry.name), state);
    }
  }

  if (process.platform === "darwin" && state.cloneAttempted && !state.cloneSupported) {
    warn(
      `jaiph docker: clonefile (cp -cR) unavailable on this filesystem; using plain copy ` +
      `(${state.firstFallbackReason ?? "unknown reason"}). Workspace clone may be slow for large trees.`,
    );
  }
}

/** Allocate a fresh sandbox workspace directory adjacent to the runs root. */
export function allocateSandboxWorkspaceDir(runsRoot: string): string {
  const id = randomBytes(4).toString("hex");
  const dir = join(runsRoot, `.sandbox-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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
  /**
   * How to make the workspace appear writable inside the container.
   *  - "overlay": bind workspace ro, set up fuse-overlayfs in-container.
   *  - "copy":    pre-clone workspace on host, bind the clone rw.
   * Defaults to `selectSandboxMode(env)` when omitted.
   */
  sandboxMode?: SandboxMode;
  /**
   * Required when `sandboxMode === "copy"`: the host path of the cloned
   * workspace to bind at `/jaiph/workspace`. Caller owns its lifecycle.
   */
  sandboxWorkspaceDir?: string;
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
 * Two sandbox shapes:
 *  - "overlay": workspace bind-mounts ro at /jaiph/workspace-ro; entrypoint
 *    script sets up fuse-overlayfs at /jaiph/workspace. Requires SYS_ADMIN
 *    and /dev/fuse. Run artifacts mount at /jaiph/run (outside the overlay).
 *  - "copy": host pre-clones workspace to `opts.sandboxWorkspaceDir`; that
 *    dir bind-mounts rw at /jaiph/workspace. No overlay script, no fuse,
 *    no SYS_ADMIN. Run artifacts mount at /jaiph/run as before.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 *
 * `overlayScriptPath` is required for "overlay" mode and ignored for "copy".
 */
export function buildDockerArgs(opts: DockerSpawnOptions, overlayScriptPath?: string): string[] {
  const mode: SandboxMode = opts.sandboxMode ?? selectSandboxMode(opts.env);
  if (mode === "overlay" && !overlayScriptPath) {
    throw new Error("buildDockerArgs: overlay mode requires overlayScriptPath");
  }
  if (mode === "copy" && !opts.sandboxWorkspaceDir) {
    throw new Error("buildDockerArgs: copy mode requires sandboxWorkspaceDir");
  }

  const args: string[] = ["run", "--rm"];

  args.push("--cap-drop", "ALL");
  if (mode === "overlay") {
    // Overlay setup runs as root, then drops to host UID/GID via setpriv.
    //   SYS_ADMIN: fuse-overlayfs mount
    //   SETUID/SETGID: setpriv uid/gid switch
    //   CHOWN: best-effort chown of /jaiph/run
    args.push("--cap-add", "SYS_ADMIN");
    args.push("--cap-add", "SETUID");
    args.push("--cap-add", "SETGID");
    args.push("--cap-add", "CHOWN");
  }
  args.push("--security-opt", "no-new-privileges");

  if (mode === "overlay") {
    args.push("--device", "/dev/fuse");
    // Many Linux hosts (Ubuntu 22.04+, GitHub Actions runners, etc.) ship a
    // default AppArmor profile that denies fuse mounts inside containers
    // even when SYS_ADMIN + /dev/fuse are present. Unconfining apparmor for
    // this single container restores the documented fuse-overlayfs
    // behavior. Linux-only: macOS Docker Desktop has no AppArmor and
    // rejects unknown security-opts on some versions.
    if (process.platform === "linux") {
      args.push("--security-opt", "apparmor=unconfined");
    }
  }

  // UID/GID strategy (Linux):
  //   copy mode    → --user host_uid:host_gid directly.
  //   overlay mode → --user 0:0 so fuse-overlayfs can mount on /jaiph/workspace.
  //                  The workflow runs as root inside the container in this mode.
  // macOS Docker Desktop translates UIDs across the VM boundary, so we don't
  // override --user there.
  let hostUid: string | undefined;
  let hostGid: string | undefined;
  if (process.platform === "linux") {
    try {
      hostUid = execSync("id -u", { encoding: "utf8" }).trim();
      hostGid = execSync("id -g", { encoding: "utf8" }).trim();
    } catch {
      // Fall through without host uid/gid.
    }
    if (mode === "overlay") {
      args.push("--user", "0:0");
    } else if (hostUid && hostGid) {
      args.push("--user", `${hostUid}:${hostGid}`);
    }
  }

  if (opts.config.network !== "default") {
    args.push("--network", opts.config.network);
  }

  if (mode === "overlay") {
    // Workspace inputs land at the overlay lower-layer path; overlay script merges them rw.
    for (const mount of opts.config.mounts) {
      const hostAbs = resolve(opts.workspaceRoot, mount.hostPath);
      validateMountHostPath(hostAbs);
      args.push("-v", `${hostAbs}:${overlayMountPath(mount.containerPath)}:ro`);
    }
  } else {
    // Pre-cloned workspace mounts rw directly at /jaiph/workspace.
    const hostAbs = resolve(opts.sandboxWorkspaceDir!);
    validateMountHostPath(hostAbs);
    args.push("-v", `${hostAbs}:${CONTAINER_WORKSPACE}:rw`);
    // Honor any additional sub-mounts (e.g. "config:ro") relative to the cloned
    // workspace, so users can still pin parts as ro inside the container.
    for (const mount of opts.config.mounts) {
      if (mount.containerPath === CONTAINER_WORKSPACE) continue;
      const subRel = relative(CONTAINER_WORKSPACE, mount.containerPath);
      if (subRel.startsWith("..")) {
        // External (non-workspace) mounts: bind the original host path through.
        const extAbs = resolve(opts.workspaceRoot, mount.hostPath);
        validateMountHostPath(extAbs);
        args.push("-v", `${extAbs}:${mount.containerPath}:${mount.mode}`);
      } else {
        const subAbs = join(hostAbs, subRel);
        args.push("-v", `${subAbs}:${mount.containerPath}:${mount.mode}`);
      }
    }
  }

  args.push("-v", `${opts.sandboxRunDir}:${CONTAINER_RUN_DIR}:rw`);

  if (mode === "overlay") {
    args.push("-v", `${overlayScriptPath}:/jaiph/overlay-run.sh:ro`);
  }

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
  if (mode === "overlay" && hostUid && hostGid) {
    args.push("-e", `JAIPH_HOST_UID=${hostUid}`);
    args.push("-e", `JAIPH_HOST_GID=${hostGid}`);
  }

  args.push("-w", CONTAINER_WORKSPACE);
  args.push(opts.config.image);

  const relSource = relative(opts.workspaceRoot, opts.sourceAbs);
  if (mode === "overlay") {
    args.push(
      "/jaiph/overlay-run.sh",
      "jaiph", "run", "--raw",
      `${CONTAINER_WORKSPACE}/${relSource}`,
      ...opts.runArgs,
    );
  } else {
    args.push(
      "jaiph", "run", "--raw",
      `${CONTAINER_WORKSPACE}/${relSource}`,
      ...opts.runArgs,
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Docker spawn with timeout + delta lifecycle
// ---------------------------------------------------------------------------

export interface DockerSpawnResult {
  child: ChildProcess;
  /** Host directory mounted at /jaiph/run — scan for artifacts after exit. */
  sandboxRunDir: string;
  /** Selected sandbox primitive for this run. */
  sandboxMode: SandboxMode;
  /** Temp directory containing overlay-run.sh — cleaned up after exit (overlay mode). */
  overlayScriptDir?: string;
  /** Pre-cloned workspace dir mounted rw — removed on cleanup unless kept (copy mode). */
  sandboxWorkspaceDir?: string;
  /** When true, cleanup leaves `sandboxWorkspaceDir` on disk for debugging. */
  keepSandboxWorkspace: boolean;
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * Spawn the Docker container.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 * Events flow via stderr; stdout carries workflow output.
 *
 * Sandbox mode is picked from `opts.sandboxMode` if set, otherwise
 * `selectSandboxMode(opts.env)`. In "copy" mode the workspace is cloned to a
 * fresh `<runsRoot>/.sandbox-<id>/` directory (or the provided
 * `opts.sandboxWorkspaceDir`) before launch.
 */
export function spawnDockerProcess(opts: DockerSpawnOptions): DockerSpawnResult {
  checkDockerAvailable();
  const resolvedImage = resolveImage(opts.config);
  opts = { ...opts, config: { ...opts.config, image: resolvedImage } };

  const mode: SandboxMode = opts.sandboxMode ?? selectSandboxMode(opts.env);
  mkdirSync(opts.sandboxRunDir, { recursive: true });
  // Linux overlay mode runs as container root. Some hosts run Docker with
  // user-namespace remapping, where container root is not host root and cannot
  // create entries in a 0755 host-owned bind mount. Make the run dir
  // world-writable so artifacts remain writable regardless of UID mapping.
  if (process.platform === "linux" && mode === "overlay") {
    try {
      chmodSync(opts.sandboxRunDir, 0o777);
    } catch {
      // Best effort: if chmod fails, docker run may still succeed on hosts
      // without user-namespace remapping.
    }
  }

  let overlayScriptPath: string | undefined;
  let overlayScriptDir: string | undefined;
  let sandboxWorkspaceDir: string | undefined;
  const keepSandboxWorkspace =
    opts.env.JAIPH_DOCKER_KEEP_SANDBOX === "1" || opts.env.JAIPH_DOCKER_KEEP_SANDBOX === "true";

  if (mode === "overlay") {
    overlayScriptPath = writeOverlayScript();
    overlayScriptDir = dirname(overlayScriptPath);
  } else {
    sandboxWorkspaceDir = opts.sandboxWorkspaceDir ?? allocateSandboxWorkspaceDir(opts.sandboxRunDir);
    cloneWorkspaceForSandbox(opts.workspaceRoot, sandboxWorkspaceDir);
  }

  opts = { ...opts, sandboxMode: mode, sandboxWorkspaceDir };
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

  return {
    child,
    sandboxRunDir: opts.sandboxRunDir,
    sandboxMode: mode,
    overlayScriptDir,
    sandboxWorkspaceDir,
    keepSandboxWorkspace,
    timeoutTimer,
  };
}

/**
 * Clean up Docker resources after execution.
 *
 * Removes the overlay script tempdir (overlay mode) and the cloned workspace
 * (copy mode), unless `JAIPH_DOCKER_KEEP_SANDBOX=1` was set.
 */
export function cleanupDocker(result: DockerSpawnResult): void {
  if (result.timeoutTimer) {
    clearTimeout(result.timeoutTimer);
  }
  if (result.overlayScriptDir) {
    try {
      rmSync(result.overlayScriptDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  if (result.sandboxWorkspaceDir && !result.keepSandboxWorkspace) {
    try {
      rmSync(result.sandboxWorkspaceDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}


