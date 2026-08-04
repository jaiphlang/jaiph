import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { GHCR_IMAGE_REPO, imageRepoName, type DockerRunConfig } from "./docker-config";

// Docker availability probe, image pull, and image verification (registry
// digest pin + jaiph-presence probe). Split out of `docker.ts` so each Docker
// concern stays under the analyzability line cap.

// ---------------------------------------------------------------------------
// Internal test seam — allows tests to intercept docker calls without DI.
// ---------------------------------------------------------------------------

export const _dockerExec = {
  /**
   * Run `docker` synchronously. Timed calls default to `killSignal: SIGKILL`
   * because Docker Desktop's CLI can ignore SIGTERM while a container sits in
   * `Created` — Node's execFileSync then waits forever past `timeout`, which
   * hung local `test:ci` / e2e on the jaiph-presence probe.
   */
  run(args: string[], opts: object): void {
    execFileSync("docker", args, { killSignal: "SIGKILL", ...(opts as object) } as any);
  },
  /** Run docker and return its stdout as a UTF-8 string (used for digest inspection). */
  capture(args: string[], opts: object): string {
    return execFileSync("docker", args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      ...(opts as object),
    }) as string;
  },
};

/**
 * Test seam for the container-indicator probe. A process reveals it is already
 * running inside a container through one of: `/.dockerenv` (Docker),
 * `/run/.containerenv` (Podman / CRI runtimes), or — in a Kubernetes pod, where
 * containerd / CRI-O create neither marker file — the kubelet-injected
 * `KUBERNETES_SERVICE_HOST` (present in every pod, never left over in a host
 * shell). Injectable so the container-detection paths can be unit-tested
 * without a real container.
 */
export const _containerIndicator = {
  present(): boolean {
    return (
      existsSync("/.dockerenv") ||
      existsSync("/run/.containerenv") ||
      (process.env.KUBERNETES_SERVICE_HOST ?? "") !== ""
    );
  },
};

/**
 * True when jaiph is running inside a container (Docker `/.dockerenv` or a
 * Podman / CRI `/run/.containerenv` marker). In that case the container itself
 * is the sandbox boundary.
 */
export function isRunningInContainer(): boolean {
  return _containerIndicator.present();
}

export function checkDockerAvailable(): void {
  try {
    _dockerExec.run(["info"], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // Docker is unavailable. If a container indicator is present we are almost
    // certainly running the runtime image directly (docker run / a k8s pod), so
    // there is no nested Docker daemon to reach — point the user at the standalone
    // story rather than telling them to install Docker.
    if (isRunningInContainer()) {
      throw new Error(
        "E_DOCKER_NOT_FOUND docker is not available, and jaiph is running inside a container already. " +
        "Set JAIPH_UNSAFE=true to run in host mode (the container is the sandbox). See https://jaiph.org/deploy for details.",
      );
    }
    throw new Error("E_DOCKER_NOT_FOUND docker is not available. Install Docker and ensure the daemon is running, or set JAIPH_UNSAFE=true to run on the host (no sandbox).");
  }
}

/** True when the image is already present in the local Docker image store. */
function imageExistsLocally(image: string): boolean {
  try {
    _dockerExec.run(["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Pull the image (`--quiet` suppresses layer progress); throws E_DOCKER_PULL on failure. */
function pullImage(image: string): void {
  try {
    _dockerExec.run(["pull", "--quiet", image], { stdio: "ignore", timeout: 300_000 });
  } catch {
    throw new Error(`E_DOCKER_PULL failed to pull image "${image}"`);
  }
}

export function pullImageIfNeeded(image: string): void {
  if (!imageExistsLocally(image)) pullImage(image);
}

/**
 * Pull the digest-pinned reference (`repo@sha256:…`) — content-addressed, so
 * Docker itself rejects any registry response whose bytes do not hash to the
 * digest — then tag it locally as `image` so the run and the presence probe,
 * which reference the image by tag, resolve the exact pinned content.
 */
function pullPinnedImage(image: string, expectedDigest: string): void {
  const pinned = `${imageRepoName(image)}@${expectedDigest}`;
  pullImage(pinned);
  try {
    _dockerExec.run(["tag", pinned, image], { stdio: "ignore", timeout: 30_000 });
  } catch {
    throw new Error(`E_DOCKER_PULL failed to tag pulled image "${pinned}" as "${image}"`);
  }
}

/**
 * Registry manifest digests recorded for a local image (`repo@sha256:…` list),
 * read from `docker image inspect`. Empty when the image carries no registry
 * digest — never pulled from a registry (locally built or `docker tag`'d) — or
 * when the image is absent / inspect fails; the caller treats an empty list as
 * "cannot prove a match" and fails closed.
 */
function localImageRepoDigests(image: string): string[] {
  let out: string;
  try {
    out = _dockerExec.capture(
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    );
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(out.trim());
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Verify the local image's registry digest matches `expectedDigest`, failing
 * closed otherwise (finding M-6). Runs on every use, including cache hits, so a
 * re-pointed tag or a poisoned local cache under the same tag cannot substitute
 * the sandbox rootfs. A no-op when no digest is pinned.
 */
export function verifyImageDigest(image: string, expectedDigest: string | undefined): void {
  if (!expectedDigest) return;
  const digests = localImageRepoDigests(image);
  const matched = digests.some((d) => {
    const at = d.lastIndexOf("@");
    return at !== -1 && d.slice(at + 1) === expectedDigest;
  });
  if (!matched) {
    const pinned = `${imageRepoName(image)}@${expectedDigest}`;
    const found = digests.length ? digests.join(", ") : "none (image not pulled from a registry)";
    throw new Error(
      `E_DOCKER_DIGEST_MISMATCH the local Docker image "${image}" does not match the expected pinned ` +
        `digest ${expectedDigest} (resolved registry digests: ${found}). A re-pointed tag or a poisoned ` +
        `local image cache can swap the sandbox rootfs, so the run is refused. Recover by re-pulling the ` +
        `pinned image: docker rmi "${image}" && docker pull ${pinned} && docker tag ${pinned} "${image}" — ` +
        `or set JAIPH_DOCKER_IMAGE_DIGEST to the digest you trust. See https://jaiph.org/sandboxing for details.`,
    );
  }
}

/**
 * Fixed non-root UID:GID for the presence probe (`nobody:nogroup`).
 *
 * The probe has no bind mounts, so — unlike a real run (`buildDockerArgs`) — it
 * never needs to match host ownership and can pin the same non-root user on
 * every platform (including macOS, where a real run leaves `--user` to Docker
 * Desktop's UID translation). `command -v jaiph` only reads PATH and executes
 * the world-executable jaiph binary, so `nobody` is sufficient.
 */
export const PROBE_USER = "65534:65534";

/**
 * Build the `docker run` argument list for the jaiph-presence probe.
 *
 * The probed image is workflow-selectable (`runtime.docker_image`) and is
 * `docker pull`ed before this runs, so it is attacker-influenced. The probe
 * therefore adopts the SAME hardening posture as a real run
 * (`buildDockerArgs`): every capability dropped, no new privileges, a non-root
 * user, and no network — so image-baked code has nothing elevated to abuse.
 *
 * The shell is a NON-login `sh -c` (never `-l`/`-lc`): a login shell sources
 * `/etc/profile` and `/etc/profile.d/*` baked into the image, executing
 * image-controlled code before we have even confirmed the image is the official
 * runtime. `command -v jaiph` needs only PATH resolution, which a non-login
 * shell provides, so nothing image-controlled is sourced or executed beyond the
 * bare PATH lookup.
 *
 * When `containerName` is set, the probe is addressable so a timed-out or
 * wedged client can still `docker rm -f` a container stuck in `Created`
 * (Docker Desktop on macOS has been observed to leave these behind, which
 * then blocks subsequent probes).
 */
export function buildImageProbeArgs(image: string, containerName?: string): string[] {
  const args = ["run", "--rm"];
  if (containerName) {
    args.push("--name", containerName);
  }
  args.push(
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    PROBE_USER,
    "--network",
    "none",
    "--entrypoint",
    "sh",
    image,
    "-c",
    "command -v jaiph >/dev/null 2>&1",
  );
  return args;
}

/** Probe timeout — must stay bounded; see `_dockerExec` killSignal note. */
export const IMAGE_PROBE_TIMEOUT_MS = 30_000;

/** How many times to retry the presence probe on Docker Desktop daemon flakes. */
export const IMAGE_PROBE_ATTEMPTS = 3;

/**
 * True when a failed probe looks like Docker Desktop / daemon flake rather than
 * "jaiph binary missing in the image". Mapping every failure to missing-jaiph
 * was the Aug 2026 overnight regression: a wedged `Created` probe or
 * `unable to upgrade to tcp, received 500` became a false E_DOCKER_NO_JAIPH
 * and agents "fixed" it by thrashing docker.ts.
 */
export function isTransientDockerProbeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException & {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    stderr?: string | Buffer;
  };
  // Node kills the docker CLI on timeout — not a "jaiph missing" signal.
  if (e.code === "ETIMEDOUT" || e.code === "EAGAIN") return true;
  if (e.killed || e.signal === "SIGKILL" || e.signal === "SIGTERM") return true;
  // Docker CLI reserved: 125 = daemon/client error. Do NOT treat container
  // exit 126/127 as transient — `command -v jaiph` missing often surfaces as
  // a normal non-zero status, and a too-broad 127 rule turned the 72 e2e
  // "missing jaiph" case into E_DOCKER_PROBE_FAILED after three retries.
  if (e.status === 125) return true;
  const msg = `${(e as Error).message ?? ""}\n${e.stderr?.toString() ?? ""}`;
  return /unable to upgrade to tcp|Cannot connect to the Docker|connection reset|received 500|context deadline exceeded/i.test(
    msg,
  );
}

function sleepMs(ms: number): void {
  // Sync sleep without adding a dependency: sleep(1) is always available on
  // macOS/Linux hosts where Docker sandboxing runs.
  try {
    execFileSync("sleep", [String(ms / 1000)], { stdio: "ignore" });
  } catch {
    // ignore
  }
}

/**
 * Probe whether `image` contains a `jaiph` binary on PATH.
 * Returns true/false for a definitive container exit. Throws
 * `E_DOCKER_PROBE_FAILED` when Docker Desktop flakes across all attempts.
 */
function imageHasJaiph(image: string): boolean {
  let lastTransient: unknown;
  for (let attempt = 1; attempt <= IMAGE_PROBE_ATTEMPTS; attempt++) {
    // Named so a hung Docker Desktop client cannot leave an anonymous Created
    // container behind after SIGKILL of the CLI — we always best-effort rm -f.
    const containerName = `jaiph-probe-${randomBytes(6).toString("hex")}`;
    try {
      // Keep stderr so daemon flakes ("unable to upgrade to tcp, received 500")
      // are classifiable; stdout stays ignored.
      _dockerExec.run(buildImageProbeArgs(image, containerName), {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: IMAGE_PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      if (isTransientDockerProbeError(err)) {
        lastTransient = err;
      } else {
        // Clean non-zero exit from `command -v jaiph` → binary really missing.
        return false;
      }
    } finally {
      try {
        _dockerExec.run(["rm", "-f", containerName], { stdio: "ignore", timeout: 10_000 });
      } catch {
        // Best-effort: container may already be gone (--rm) or docker unavailable.
      }
    }
    if (attempt < IMAGE_PROBE_ATTEMPTS) sleepMs(500 * attempt);
  }
  const detail =
    lastTransient instanceof Error ? lastTransient.message : String(lastTransient ?? "unknown");
  throw new Error(
    `E_DOCKER_PROBE_FAILED presence probe for "${image}" failed after ` +
      `${IMAGE_PROBE_ATTEMPTS} attempts (Docker daemon flake or timeout), not a missing jaiph binary. ` +
      `Last error: ${detail}. Retry when Docker Desktop is healthy; do not lengthen probe timeouts in docker.ts.`,
  );
}

/**
 * Verify that the selected Docker image contains `jaiph`.
 * Fails fast with an actionable error when the binary is missing.
 * Distinguishes daemon flakes (`E_DOCKER_PROBE_FAILED`) from a bad image.
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
  const expectedDigest = config.expectedDigest;

  if (!imageExistsLocally(image)) {
    process.stderr.write(`pulling image ${image}…\n`);
    // Resolve/pull by digest when one is pinned: content-addressed, so a
    // compromised registry or a re-pointed tag cannot substitute the rootfs.
    if (expectedDigest) {
      pullPinnedImage(image, expectedDigest);
    } else {
      pullImage(image);
    }
    process.stderr.write(`pulled\n`);
  }

  // Verify the resolved local digest on every run, including the cache-hit path
  // above (finding M-6). Fail closed before the image is used as the sandbox
  // boundary; the presence probe below then runs image-baked code.
  verifyImageDigest(image, expectedDigest);
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
