import { execFileSync, spawn, spawnSync, ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import type { RuntimeConfig } from "../types";

/** Resolved Docker runtime config with defaults applied and env overrides merged. */
export interface DockerRunConfig {
  enabled: boolean;
  image: string;
  /** True when image was explicitly set via env or in-file config (not the default). */
  imageExplicit: boolean;
  network: string;
  timeout: number;
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
};

/**
 * Resolve effective Docker config.
 * Precedence: env vars (`JAIPH_DOCKER_*`) > unsafe default rule.
 *
 * Default rule (when no explicit `JAIPH_DOCKER_ENABLED` is set):
 *  - `JAIPH_UNSAFE=true` → Docker off (explicit "run on host" escape hatch)
 *  - Otherwise → Docker on (including in CI; CI=true alone no longer disables Docker)
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  // enabled: env JAIPH_DOCKER_ENABLED > unsafe default rule
  let enabled: boolean;
  if (env.JAIPH_DOCKER_ENABLED !== undefined) {
    enabled = env.JAIPH_DOCKER_ENABLED === "true";
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
    const raw = env.JAIPH_DOCKER_TIMEOUT;
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(
        `E_DOCKER_TIMEOUT JAIPH_DOCKER_TIMEOUT must be a non-negative integer (or 0 to disable), got "${raw}"`,
      );
    }
    timeout = parseInt(raw, 10);
    if (timeout < 0) {
      throw new Error(
        `E_DOCKER_TIMEOUT JAIPH_DOCKER_TIMEOUT must be a non-negative integer (or 0 to disable), got "${raw}"`,
      );
    }
  } else {
    timeout = inFile?.dockerTimeout ?? DEFAULTS.timeout;
    if (timeout < 0) {
      throw new Error(
        `E_DOCKER_TIMEOUT runtime.docker_timeout must be a non-negative integer (or 0 to disable), got "${timeout}"`,
      );
    }
  }

  return { enabled, image, imageExplicit, network, timeout };
}

// ---------------------------------------------------------------------------
// Internal test seam — allows tests to intercept docker calls without DI.
// ---------------------------------------------------------------------------

export const _dockerExec = {
  run(args: string[], opts: object): void {
    execFileSync("docker", args, opts as any);
  },
};

/** Test seam for host UID/GID detection — allows tests to simulate detection failure. */
export const _uidDetect = {
  getHostUidGid(): { uid: string; gid: string } | undefined {
    let uid: string | undefined;
    let gid: string | undefined;
    try {
      if (typeof process.getuid === "function") uid = String(process.getuid());
      if (typeof process.getgid === "function") gid = String(process.getgid());
    } catch {
      // Fall through to shell fallback below.
    }
    if (!uid || !gid) {
      try {
        uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
        gid = execFileSync("id", ["-g"], { encoding: "utf8" }).trim();
      } catch {
        // Both detection paths failed.
      }
    }
    return uid && gid ? { uid, gid } : undefined;
  },
};

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export function checkDockerAvailable(): void {
  try {
    _dockerExec.run(["info"], { stdio: "ignore", timeout: 10_000 });
  } catch {
    throw new Error("E_DOCKER_NOT_FOUND docker is not available. Install Docker and ensure the daemon is running, or set JAIPH_UNSAFE=true to run on the host (no sandbox).");
  }
}

// ---------------------------------------------------------------------------
// Image pull
// ---------------------------------------------------------------------------

export function pullImageIfNeeded(image: string): void {
  try {
    _dockerExec.run(["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
  } catch {
    // Image not present locally — pull it (--quiet suppresses layer progress)
    try {
      _dockerExec.run(["pull", "--quiet", image], { stdio: "ignore", timeout: 300_000 });
    } catch {
      throw new Error(`E_DOCKER_PULL failed to pull image "${image}"`);
    }
  }
}

function imageHasJaiph(image: string): boolean {
  try {
    _dockerExec.run(
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
 * Pre-pull the Docker image (if not local) and verify it contains `jaiph`.
 *
 * Intended to run **before** the CLI banner so Docker's pull overhead doesn't
 * interleave with the progress tree. On a cold pull, writes a single
 * `pulling image <name>…` status line to stderr; Docker's native progress is
 * suppressed via `--quiet`.
 */
export function prepareImage(config: DockerRunConfig): string {
  const image = config.image;

  let needsPull = false;
  try {
    _dockerExec.run(["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
  } catch {
    needsPull = true;
  }

  if (needsPull) {
    process.stderr.write(`pulling image ${image}…\n`);
    try {
      _dockerExec.run(["pull", "--quiet", image], { stdio: "ignore", timeout: 300_000 });
    } catch {
      throw new Error(`E_DOCKER_PULL failed to pull image "${image}"`);
    }
    process.stderr.write(`pulled\n`);
  }

  verifyImageHasJaiph(image);
  return image;
}

/**
 * Resolve the Docker image to use.
 *
 * Thin wrapper around `prepareImage` — kept for back-compat in tests.
 */
export function resolveImage(config: DockerRunConfig): string {
  return prepareImage(config);
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

/**
 * Explicit allowlist of environment variable prefixes forwarded into the
 * container. Everything else is dropped — fail-closed by design.
 */
const ENV_ALLOW_PREFIXES = ["JAIPH_", "ANTHROPIC_", "CURSOR_", "CLAUDE_"] as const;

/** Prefix excluded from the allowlist even though it starts with JAIPH_. */
const ENV_ALLOW_EXCLUDE_PREFIX = "JAIPH_DOCKER_";

/** Returns true if `key` is on the explicit allowlist for container forwarding. */
export function isEnvAllowed(key: string): boolean {
  if (key.startsWith(ENV_ALLOW_EXCLUDE_PREFIX)) return false;
  return ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix));
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
 *
 * Host-side `resolveRuntimeEnv` resolves several JAIPH_* keys to absolute
 * host paths (the workspace root, agent trusted workspace, runs dir). Those
 * paths do not exist inside the container — the workspace is bind-mounted at
 * /jaiph/workspace and run artifacts at /jaiph/run. If we forwarded them
 * unchanged the container would receive nonsense paths; worse, they reach
 * agent CLIs (cursor-agent --trust <path>) and surface in model context,
 * confusing the model into reporting it can't access "/tmp/jaiph-run-XXX".
 *
 * - JAIPH_WORKSPACE              → /jaiph/workspace (always)
 * - JAIPH_RUNS_DIR               → /jaiph/run      (always)
 * - JAIPH_AGENT_TRUSTED_WORKSPACE → remapped from <workspaceRoot>[/sub] to
 *                                   /jaiph/workspace[/sub] when it points
 *                                   inside the workspace; otherwise left as
 *                                   the explicit absolute path the user set.
 */
export function remapDockerEnv(
  env: Record<string, string | undefined>,
  workspaceRoot?: string,
): Record<string, string | undefined> {
  const out = { ...env };
  out.JAIPH_WORKSPACE = CONTAINER_WORKSPACE;
  out.JAIPH_RUNS_DIR = CONTAINER_RUN_DIR;
  if (workspaceRoot && out.JAIPH_AGENT_TRUSTED_WORKSPACE) {
    const trusted = out.JAIPH_AGENT_TRUSTED_WORKSPACE;
    if (trusted === workspaceRoot) {
      out.JAIPH_AGENT_TRUSTED_WORKSPACE = CONTAINER_WORKSPACE;
    } else if (trusted.startsWith(workspaceRoot + "/")) {
      out.JAIPH_AGENT_TRUSTED_WORKSPACE = CONTAINER_WORKSPACE + trusted.slice(workspaceRoot.length);
    }
  }
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
    //   DAC_READ_SEARCH: fuse-overlayfs daemon (running as root) needs to read
    //     lower-layer files owned by host_uid with restrictive perms (e.g. 0600
    //     workflow files, 0700 workspace dirs) so the kernel can serve them
    //     through the merged view to the dropped-uid workflow process.
    args.push("--cap-add", "SYS_ADMIN");
    args.push("--cap-add", "SETUID");
    args.push("--cap-add", "SETGID");
    args.push("--cap-add", "CHOWN");
    args.push("--cap-add", "DAC_READ_SEARCH");
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
    const detected = _uidDetect.getHostUidGid();
    if (!detected) {
      throw new Error(
        "E_DOCKER_UID failed to determine host UID/GID; refusing to run sandbox as root.",
      );
    }
    hostUid = detected.uid;
    hostGid = detected.gid;
    if (mode === "overlay") {
      args.push("--user", "0:0");
    } else {
      args.push("--user", `${hostUid}:${hostGid}`);
    }
  }

  if (opts.config.network !== "default") {
    args.push("--network", opts.config.network);
  }

  // Single workspace mount — no user-configurable mounts.
  if (mode === "overlay") {
    const hostAbs = resolve(opts.workspaceRoot);
    validateMountHostPath(hostAbs);
    args.push("-v", `${hostAbs}:${overlayMountPath(CONTAINER_WORKSPACE)}:ro`);
  } else {
    const hostAbs = resolve(opts.sandboxWorkspaceDir!);
    validateMountHostPath(hostAbs);
    args.push("-v", `${hostAbs}:${CONTAINER_WORKSPACE}:rw`);
  }

  args.push("-v", `${opts.sandboxRunDir}:${CONTAINER_RUN_DIR}:rw`);

  if (mode === "overlay") {
    args.push("-v", `${overlayScriptPath}:/jaiph/overlay-run.sh:ro`);
  }

  const containerEnv = remapDockerEnv(opts.env, opts.workspaceRoot);
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value === undefined) continue;
    if (!isEnvAllowed(key)) continue;
    args.push("-e", `${key}=${value}`);
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
  /** Set to true after cleanupDocker has run — prevents double-rmSync. */
  cleaned?: boolean;
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
  if (result.cleaned) return;
  result.cleaned = true;
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


