import { execFileSync, spawn, spawnSync, ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import type { RuntimeConfig } from "../types";
import { VERSION } from "../version";
import { OVERLAY_RUN_SH_BASE64, decodeEmbeddedAsset } from "./embedded-assets";
import { killProcessTree } from "./kernel/portability";

/** Resolved Docker runtime config with defaults applied and env overrides merged. */
export interface DockerRunConfig {
  enabled: boolean;
  image: string;
  /** True when image was explicitly set via env or in-file config (not the default). */
  imageExplicit: boolean;
  network: string;
  timeoutSeconds: number;
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

/**
 * Read the jaiph package version to derive the default GHCR image tag.
 *
 * Tries two relative layouts:
 * - Installer (`docs/install`): `…/libDir/package.json` next to `libDir/src/runtime/` (two hops up).
 * - npm / repo build: `…/pkg/package.json` from `pkg/dist/src/runtime/` (three hops up).
 * - Standalone binary (no package.json on disk): embedded `VERSION` from `src/version.ts`.
 */
export function resolveDefaultDockerImageTag(moduleDir: string = __dirname): string {
  const candidates = [
    resolve(moduleDir, "..", "..", "package.json"),
    resolve(moduleDir, "..", "..", "..", "package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.version && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // Try next candidate.
    }
  }
  return VERSION;
}

export const GHCR_IMAGE_REPO = "ghcr.io/jaiphlang/jaiph-runtime";

const DEFAULTS: DockerRunConfig = {
  enabled: false,
  image: `${GHCR_IMAGE_REPO}:${resolveDefaultDockerImageTag()}`,
  imageExplicit: false,
  network: "default",
  timeoutSeconds: 14400,
};

/**
 * Test seam for the one-time win32 host-only notice. Tests reset `emitted`
 * between runs and can spy `write` to assert the notice fires exactly once.
 */
export const _win32Notice = {
  emitted: false,
  write(message: string): void {
    process.stderr.write(message);
  },
};

/** Emit the win32 host-only notice at most once per process. */
function emitWin32HostOnlyNotice(): void {
  if (_win32Notice.emitted) return;
  _win32Notice.emitted = true;
  _win32Notice.write(
    "jaiph: Docker sandbox is not supported on Windows; running host-only (no sandbox).\n",
  );
}

/**
 * Resolve effective Docker config.
 * Precedence: platform > env vars (`JAIPH_DOCKER_*`) > unsafe default rule.
 *
 * On win32 the Docker sandbox is out of scope: resolution is forced to
 * host-only mode (same UX as an explicit `JAIPH_UNSAFE=true`) with a one-line
 * notice, so the CLI never probes `docker` and never hard-fails on a missing
 * daemon. `JAIPH_DOCKER_ENABLED=true` cannot override this.
 *
 * Default rule (when no explicit `JAIPH_DOCKER_ENABLED` is set):
 *  - `JAIPH_UNSAFE=true` → Docker off (explicit "run on host" escape hatch)
 *  - Otherwise → Docker on (including in CI; CI=true alone no longer disables Docker)
 */
export function resolveDockerConfig(
  inFile: RuntimeConfig | undefined,
  env: Record<string, string | undefined>,
): DockerRunConfig {
  // enabled: win32 host-only override > env JAIPH_DOCKER_ENABLED > unsafe default rule
  let enabled: boolean;
  if (process.platform === "win32") {
    emitWin32HostOnlyNotice();
    enabled = false;
  } else if (env.JAIPH_DOCKER_ENABLED !== undefined) {
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
  let timeoutSeconds: number;
  if (env.JAIPH_DOCKER_TIMEOUT !== undefined) {
    const raw = env.JAIPH_DOCKER_TIMEOUT;
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `E_DOCKER_TIMEOUT JAIPH_DOCKER_TIMEOUT must be a non-negative integer (or 0 to disable), got "${raw}"`,
      );
    }
    timeoutSeconds = parseInt(raw, 10);
  } else {
    timeoutSeconds = inFile?.dockerTimeoutSeconds ?? DEFAULTS.timeoutSeconds;
    if (timeoutSeconds < 0) {
      throw new Error(
        `E_DOCKER_TIMEOUT runtime.docker_timeout_seconds must be a non-negative integer (or 0 to disable), got "${timeoutSeconds}"`,
      );
    }
  }

  return { enabled, image, imageExplicit, network, timeoutSeconds };
}

// ---------------------------------------------------------------------------
// Internal test seam — allows tests to intercept docker calls without DI.
// ---------------------------------------------------------------------------

export const _dockerExec = {
  run(args: string[], opts: object): void {
    execFileSync("docker", args, opts as any);
  },
};

/** Test seam for the long-running `docker run` spawn — stubbed by spawn tests. */
export const _dockerSpawn = {
  run(args: string[], opts: object): ChildProcess {
    return spawn("docker", args, opts as any);
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
 * Container-side fuse-overlayfs setup loaded from runtime/overlay-run.sh.
 *
 * Resolves the script in this order, so the npm/disk install and the
 * bun-compiled standalone binary both work:
 *   1. Sibling `overlay-run.sh` next to this module (npm `dist/src/runtime/`).
 *   2. Repo-root `runtime/overlay-run.sh` three hops up (dev `src/runtime/`).
 *   3. Embedded base64 baked into the executable (bun --compile binary).
 * Lazy so importing the docker module from non-Docker code paths never
 * touches the asset.
 */
let overlayScriptCache: string | undefined;

export function loadOverlayScript(): string {
  if (overlayScriptCache !== undefined) return overlayScriptCache;
  const diskCandidates = [
    resolve(__dirname, "overlay-run.sh"),
    resolve(__dirname, "..", "..", "..", "runtime", "overlay-run.sh"),
  ];
  for (const scriptPath of diskCandidates) {
    if (existsSync(scriptPath)) {
      overlayScriptCache = readFileSync(scriptPath, "utf8");
      return overlayScriptCache;
    }
  }
  overlayScriptCache = decodeEmbeddedAsset(OVERLAY_RUN_SH_BASE64);
  return overlayScriptCache;
}

/**
 * Write overlay-run.sh to a temp file and return its path.
 * Mounted read-only at /jaiph/overlay-run.sh inside the container.
 */
export function writeOverlayScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-overlay-"));
  const scriptPath = join(dir, "overlay-run.sh");
  writeFileSync(scriptPath, loadOverlayScript(), { mode: 0o755 });
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Sandbox mode selection + host-side workspace clone
// ---------------------------------------------------------------------------

/** Selected sandbox primitive for a Docker run. */
export type SandboxMode = "overlay" | "copy" | "inplace";

/**
 * Choose the sandbox mode for the upcoming run.
 *
 * `JAIPH_INPLACE` is the highest-priority opt-in: when truthy, the host
 * workspace is bind-mounted rw directly so the run's edits land live on the
 * host. The machine boundary (mount set, caps, env allowlist) is unchanged.
 * Otherwise, presence of `/dev/fuse` on the host is a strong proxy for
 * fuse-overlayfs viability inside the container. Linux dev/CI hosts typically
 * have it; macOS Docker Desktop typically doesn't expose it. Override with
 * `JAIPH_DOCKER_NO_OVERLAY=1` to force the host-copy path.
 */
export function selectSandboxMode(env: Record<string, string | undefined>): SandboxMode {
  if (env.JAIPH_INPLACE === "1" || env.JAIPH_INPLACE === "true") {
    return "inplace";
  }
  if (env.JAIPH_DOCKER_NO_OVERLAY === "1" || env.JAIPH_DOCKER_NO_OVERLAY === "true") {
    return "copy";
  }
  return existsSync("/dev/fuse") ? "overlay" : "copy";
}

/**
 * Choose the sandbox mode for a `jaiph mcp` tool call.
 *
 * Delegates to `selectSandboxMode` so MCP and `jaiph run` share identical
 * semantics: overlay or copy by default (workspace isolated), inplace only
 * when `JAIPH_INPLACE=1|true`. `JAIPH_DOCKER_NO_OVERLAY` forces copy in both
 * contexts. Kept as a named export so callers and tests import a stable symbol.
 */
export function selectMcpSandboxMode(env: Record<string, string | undefined>): SandboxMode {
  return selectSandboxMode(env);
}

/** Run `cp` with the given flags. Returns true on success. */
function tryCp(flags: string[], src: string, dst: string): { ok: boolean; stderr: string } {
  const r = spawnSync("cp", [...flags, src, dst], { stdio: ["ignore", "ignore", "pipe"] });
  return { ok: r.status === 0, stderr: r.stderr?.toString() ?? "" };
}

/**
 * Handles workspace cloning with automatic clonefile detection and fallback.
 *
 * On macOS, the first `copy()` call probes `cp -cR` (APFS clonefile, O(1)).
 * If it works, subsequent calls use clonefile directly. If it fails, all calls
 * fall back to `cp -pR` and the reason is recorded for a one-time warning.
 * On Linux/other platforms, always uses `cp -pR`.
 */
class WorkspaceCloner {
  private cloneAttempted = false;
  private cloneSupported = false;
  private firstFallbackReason: string | null = null;

  copy(src: string, dst: string): void {
    if (process.platform !== "darwin") {
      const r = tryCp(["-pR"], src, dst);
      if (!r.ok) {
        throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${r.stderr.trim()}`);
      }
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
      const fb = tryCp(["-pR"], src, dst);
      if (!fb.ok) {
        throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${fb.stderr.trim()}`);
      }
      return;
    }

    if (this.cloneSupported) {
      const r = tryCp(["-cR"], src, dst);
      if (r.ok) return;
    }
    const fb = tryCp(["-pR"], src, dst);
    if (!fb.ok) {
      throw new Error(`E_DOCKER_SANDBOX_COPY failed to copy ${src} → ${dst}: ${fb.stderr.trim()}`);
    }
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
  const cloner = new WorkspaceCloner();

  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (entry.name === ".jaiph") continue;
    cloner.copy(join(srcRoot, entry.name), join(dstRoot, entry.name));
  }

  const jaiphSrc = join(srcRoot, ".jaiph");
  if (existsSync(jaiphSrc)) {
    const jaiphDst = join(dstRoot, ".jaiph");
    mkdirSync(jaiphDst, { recursive: true });
    for (const entry of readdirSync(jaiphSrc, { withFileTypes: true })) {
      if (entry.name === "runs") continue;
      cloner.copy(join(jaiphSrc, entry.name), join(jaiphDst, entry.name));
    }
  }

  if (process.platform === "darwin" && cloner.fellBackToPlainCopy) {
    warn(
      `jaiph docker: clonefile (cp -cR) unavailable on this filesystem; using plain copy ` +
      `(${cloner.fallbackReason}). Workspace clone may be slow for large trees.`,
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
  /**
   * Explicit per-key env passthrough from `--env` (see `resolveEnvPairs`).
   * Appended as `-e KEY=VALUE` container args **bypassing `isEnvAllowed`** —
   * the flag is the per-key user consent. Values are passed verbatim (no path
   * remapping). Each key appears once: an `extraEnv` entry wins over the same
   * key forwarded through the allowlist. Reserved keys are rejected upstream.
   */
  extraEnv?: Record<string, string>;
  /**
   * Agent backends the entry file can select (module config, workflow config,
   * and the `JAIPH_AGENT_BACKEND`/default fallback — see `collectEntryBackends`
   * in `src/cli/run/preflight-credentials.ts`). Only the enumerated credential
   * keys for these backends are forwarded (`BACKEND_CREDENTIAL_KEYS`).
   * Omitted or empty → no backend credential keys cross (fail-closed).
   */
  backends?: readonly AgentBackend[];
  isTTY: boolean;
  /**
   * Workflow symbol the inner `jaiph run --raw` should execute as its root.
   * Carried into the container as `-e JAIPH_RUN_WORKFLOW=<symbol>` (read by
   * `runWorkflowRaw`) so a non-`default` root — e.g. an MCP tool call — runs
   * correctly. Omitted / `"default"` leaves the inner run on its `default`
   * entrypoint (the `jaiph run` contract), so no env var is emitted.
   */
  workflowSymbol?: string;
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
  /**
   * Deterministic `--name` for the spawned container. Set by
   * `spawnDockerProcess` so an interrupt (or timeout) can force-remove the
   * container by name even if the host `docker` client was killed without
   * tearing it down. Omitted callers of `buildDockerArgs` skip `--name`.
   */
  containerName?: string;
}

export const CONTAINER_WORKSPACE = "/jaiph/workspace";
export const CONTAINER_RUN_DIR = "/jaiph/run";

/** Agent backends the runtime can execute prompts against. */
export type AgentBackend = "cursor" | "claude" | "codex";

/**
 * Enumerated credential keys forwarded into the container per agent backend.
 * Only the keys for the run's resolved backends cross the boundary — the rest
 * of the `ANTHROPIC_*` / `CLAUDE_*` / `CURSOR_*` / `OPENAI_*` families stay on
 * the host. Anything else goes through the explicit `--env` escape hatch.
 * Must stay in sync with the credential pre-flight
 * (`src/cli/run/preflight-credentials.ts`) and docs/env-vars.md.
 */
export const BACKEND_CREDENTIAL_KEYS: Record<AgentBackend, readonly string[]> = {
  cursor: ["CURSOR_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};

/**
 * Environment variable prefixes forwarded into the container. Only `JAIPH_*`
 * run-control keys are prefix-forwarded — the runtime inside the container
 * consumes them (with `JAIPH_DOCKER_*` and the explicit name exclusions below
 * carved out). Agent credentials are NOT prefix-forwarded: only the enumerated
 * per-backend keys in `BACKEND_CREDENTIAL_KEYS` cross, and only for the run's
 * resolved backends. Everything else is dropped — fail-closed by design.
 */
export const ENV_ALLOW_PREFIXES = ["JAIPH_"] as const;

/** Prefix excluded from the allowlist even though it starts with JAIPH_. */
export const ENV_ALLOW_EXCLUDE_PREFIX = "JAIPH_DOCKER_";

/**
 * Container env var naming the workflow symbol the inner `jaiph run --raw`
 * should execute. Emitted explicitly from `DockerSpawnOptions.workflowSymbol`
 * (see `buildDockerArgs`), never auto-forwarded from the host env — so it is
 * excluded from the allowlist below and reserved against `--env`.
 */
export const RUN_WORKFLOW_ENV = "JAIPH_RUN_WORKFLOW";

/**
 * Explicit exclusions that would otherwise pass the JAIPH_ allowlist.
 * Forwarding these would leak host control flags into the container (and let a
 * nested run re-trigger the same mode).
 */
export const ENV_ALLOW_EXCLUDE_NAMES = new Set<string>([
  "JAIPH_INPLACE",
  "JAIPH_INPLACE_YES",
  // Never inherit a stale symbol from the host env: the inner run's root is
  // set only through the explicit `workflowSymbol` wiring below.
  RUN_WORKFLOW_ENV,
]);

/**
 * Returns true if `key` may be forwarded into the container for a run that
 * resolved to `backends`. `JAIPH_*` run-control keys pass regardless of
 * backend (minus the exclusions); credential keys pass only when one of the
 * given backends needs them (`BACKEND_CREDENTIAL_KEYS`). An empty `backends`
 * forwards no credentials — fail-closed.
 */
export function isEnvAllowed(key: string, backends: readonly AgentBackend[]): boolean {
  if (key.startsWith(ENV_ALLOW_EXCLUDE_PREFIX)) return false;
  if (ENV_ALLOW_EXCLUDE_NAMES.has(key)) return false;
  if (ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  // Guard the lookup: `backends` may carry an unrecognized JAIPH_AGENT_BACKEND
  // value at runtime, which forwards nothing rather than throwing.
  return backends.some((backend) => BACKEND_CREDENTIAL_KEYS[backend]?.includes(key) ?? false);
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
 * Three sandbox shapes:
 *  - "overlay": workspace bind-mounts ro at /jaiph/workspace-ro; entrypoint
 *    script sets up fuse-overlayfs at /jaiph/workspace. Requires SYS_ADMIN
 *    and /dev/fuse. Run artifacts mount at /jaiph/run (outside the overlay).
 *  - "copy": host pre-clones workspace to `opts.sandboxWorkspaceDir`; that
 *    dir bind-mounts rw at /jaiph/workspace. No overlay script, no fuse,
 *    no SYS_ADMIN. Run artifacts mount at /jaiph/run as before.
 *  - "inplace": host workspace itself bind-mounts rw at /jaiph/workspace —
 *    edits land live on the host. Same caps/network/env posture as "copy".
 *    Concurrent runs on the same workspace are a known sharp edge — no
 *    locking is performed.
 *
 * The container runs `jaiph run --raw <file>` using its own installed jaiph.
 *
 * `overlayScriptPath` is required for "overlay" mode and ignored for the rest.
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
  // Deterministic name so an interrupt / timeout can force-remove this exact
  // container even if the host `docker` client is killed without tearing it down.
  if (opts.containerName) {
    args.push("--name", opts.containerName);
  }

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
  } else if (mode === "inplace") {
    const hostAbs = resolve(opts.workspaceRoot);
    validateMountHostPath(hostAbs);
    args.push("-v", `${hostAbs}:${CONTAINER_WORKSPACE}:rw`);
  } else {
    const hostAbs = resolve(opts.sandboxWorkspaceDir!);
    validateMountHostPath(hostAbs);
    args.push("-v", `${hostAbs}:${CONTAINER_WORKSPACE}:rw`);
  }

  args.push("-v", `${opts.sandboxRunDir}:${CONTAINER_RUN_DIR}:rw`);

  if (mode === "overlay") {
    args.push("-v", `${overlayScriptPath}:/jaiph/overlay-run.sh:ro`);
  }

  const extraEnv = opts.extraEnv ?? {};
  const backends = opts.backends ?? [];
  const containerEnv = remapDockerEnv(opts.env, opts.workspaceRoot);
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value === undefined) continue;
    if (!isEnvAllowed(key, backends)) continue;
    // `--env` supplies this key explicitly below; skip the allowlist copy so it
    // appears once, with the `--env` value winning.
    if (key in extraEnv) continue;
    args.push("-e", `${key}=${value}`);
  }
  // Explicit `--env` passthrough: crosses the boundary verbatim regardless of
  // isEnvAllowed — the flag is the per-key consent.
  for (const [key, value] of Object.entries(extraEnv)) {
    args.push("-e", `${key}=${value}`);
  }
  // Carry the inner run's root symbol. `jaiph run --raw` defaults to `default`,
  // so only a non-default root needs the explicit selector.
  if (opts.workflowSymbol && opts.workflowSymbol !== "default") {
    args.push("-e", `${RUN_WORKFLOW_ENV}=${opts.workflowSymbol}`);
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
  /** `--name` of the spawned container — used to force-remove it on interrupt/timeout. */
  containerName?: string;
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
  } else if (mode === "copy") {
    sandboxWorkspaceDir = opts.sandboxWorkspaceDir ?? allocateSandboxWorkspaceDir(opts.sandboxRunDir);
    cloneWorkspaceForSandbox(opts.workspaceRoot, sandboxWorkspaceDir);
  }
  // inplace: no overlay script, no workspace clone — the host workspace is
  // bind-mounted rw directly. The runs mount is still created above.

  // Deterministic container name so an interrupt or timeout can force-remove
  // this exact container by name, regardless of the host `docker` client's fate.
  const containerName = `jaiph-run-${randomBytes(6).toString("hex")}`;
  opts = { ...opts, sandboxMode: mode, sandboxWorkspaceDir, containerName };
  const dockerArgs = buildDockerArgs(opts, overlayScriptPath);

  const child = _dockerSpawn.run(dockerArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.workspaceRoot,
    env: opts.env,
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.config.timeoutSeconds > 0) {
    timeoutTimer = setTimeout(() => {
      // Force-remove the container by name first: a `docker run --rm` container
      // can outlive its client (Docker Desktop / detached), so killing the
      // client's process tree alone is not enough to stop the container.
      stopDockerContainer(containerName);
      const pid = child.pid;
      if (!pid) {
        return;
      }
      // Terminate the `docker run` client and its descendants. On win32 the
      // taskkill /T force-kills the tree, so the SIGKILL escalation below is a
      // documented no-op there (see killProcessTree).
      killProcessTree(pid, "SIGTERM");
      setTimeout(() => {
        killProcessTree(pid, "SIGKILL");
      }, 5000);
    }, opts.config.timeoutSeconds * 1000);
  }

  return {
    child,
    containerName,
    sandboxRunDir: opts.sandboxRunDir,
    sandboxMode: mode,
    overlayScriptDir,
    sandboxWorkspaceDir,
    keepSandboxWorkspace,
    timeoutTimer,
  };
}

/**
 * Force-stop and remove the named container. Best-effort and bounded so it is
 * safe to call inside a SIGINT/SIGTERM handler.
 *
 * Two-step: `docker kill` first (sends SIGKILL, returns quickly once the signal
 * is delivered — container disappears from `docker ps` within a second), then
 * `docker rm -f` on the now-stopped container (fast because no process teardown
 * is needed). Splitting kill from rm avoids the macOS Docker Desktop lock
 * contention that can cause a single `docker rm -f` on a running container to
 * block for the full 10-second execFileSync timeout when the host `docker run`
 * client is also in the middle of its own SIGINT-triggered stop sequence.
 */
export function stopDockerContainer(containerName: string | undefined): void {
  if (!containerName) return;
  // Kill the container first — SIGKILL via daemon, returns as soon as the
  // signal is queued. Container exits within milliseconds.
  try {
    _dockerExec.run(["kill", containerName], { stdio: "ignore", timeout: 5_000 });
  } catch {
    // Best-effort: the container may already be stopped or gone.
  }
  // Remove the (now-stopped) container record. Fast path: no live process to
  // tear down, so this completes quickly even on macOS Docker Desktop.
  try {
    _dockerExec.run(["rm", "-f", containerName], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // Best-effort: the container may already be gone, or docker unavailable.
  }
}

/**
 * SIGINT/SIGTERM cleanup for a Docker-backed run: stop and remove the container
 * first, then remove the host sandbox clone. Order matters — the sandbox dir is
 * bind-mounted into the container, so it must not be deleted while the container
 * is still running.
 */
export function stopDockerRunOnSignal(result: DockerSpawnResult): void {
  stopDockerContainer(result.containerName);
  cleanupDocker(result);
}

/**
 * Clean up Docker resources after execution.
 *
 * Idempotent: subsequent calls on the same `result` short-circuit on
 * `result.cleaned` — exit-guard + finally-path pairing relies on this.
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

/**
 * Run `body` with an abnormal-exit cleanup guard registered on `process.on("exit")`.
 *
 * Registration and removal are paired via try/finally: on both normal return
 * and on throw, the listener is removed and `cleanupDocker(dockerResult)` is
 * called exactly once. The guard only fires when the process exits before the
 * finally runs (e.g. crash, unhandled exception in the host) — that's its
 * purpose. When `dockerResult` is undefined (non-Docker run), no listener is
 * registered.
 */
export async function withDockerExitGuard<T>(
  dockerResult: DockerSpawnResult | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (!dockerResult) return body();
  const guard = (): void => { cleanupDocker(dockerResult); };
  process.on("exit", guard);
  try {
    return await body();
  } finally {
    cleanupDocker(dockerResult);
    process.removeListener("exit", guard);
  }
}


