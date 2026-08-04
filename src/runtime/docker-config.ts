import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../types";
import { VERSION, RUNTIME_IMAGE_DIGEST } from "../version";

// Docker config resolution (env > in-file > defaults) and image-reference /
// digest helpers. Split out of `docker.ts` (the facade) so each Docker concern
// stays under the analyzability line cap.

/** Resolved Docker runtime config with defaults applied and env overrides merged. */
export interface DockerRunConfig {
  enabled: boolean;
  image: string;
  /**
   * True when the image was explicitly set by the operator via
   * `JAIPH_DOCKER_IMAGE` (not the default). In-file `runtime.docker_image` is
   * host-controlled and never selects the image (see `resolveDockerConfig`).
   */
  imageExplicit: boolean;
  network: string;
  timeoutSeconds: number;
  /**
   * Expected manifest digest (`sha256:<64 hex>`) the resolved local image must
   * match on every run, including cache hits (finding M-6). The runtime image
   * is the boundary between untrusted workflows and the host, so a re-pointed
   * tag or a poisoned local cache under the same tag must fail closed rather
   * than silently substitute the sandbox rootfs. `undefined` disables digest
   * enforcement — a custom operator image with no pin, or the default image
   * before the release pipeline bakes its digest (see `resolveExpectedDigest`).
   */
  expectedDigest?: string;
}

/**
 * Whether a file-declared `runtime.docker_network` value is safe to honour.
 *
 * An entry file is repo- or model-supplied and therefore untrusted: it must not
 * be able to dissolve the container's network isolation (finding M-6). `host`
 * shares the host network namespace (reaching loopback-only services and binding
 * host ports); `container:<name>` and `ns:<path>` join another namespace. Those
 * are host-controlled only — the operator may still opt in through
 * `JAIPH_DOCKER_NETWORK` (trusted, used verbatim).
 *
 * Safe in-file values are `default`, `none`, and plain named (bridge) networks:
 * a bare identifier with no namespace-join `:` / path syntax, and never `host`.
 */
export function isHostSafeInFileNetwork(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== "host";
}

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
 * Strip any `:tag` and/or `@sha256:…` suffix, returning the bare repository.
 *
 * A `:` after the last `/` is a tag separator; a `:` inside the registry host
 * (e.g. `localhost:5000/x`) is a port and is preserved.
 */
export function imageRepoName(image: string): string {
  const at = image.indexOf("@");
  const noDigest = at === -1 ? image : image.slice(0, at);
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  return colon === -1 ? noDigest : noDigest.slice(0, colon);
}

/**
 * Normalize a manifest digest to canonical `sha256:<64 hex>` form, or return
 * `undefined` for an empty/malformed value. Accepts a bare 64-hex digest and
 * prepends the `sha256:` algorithm prefix.
 */
export function normalizeImageDigest(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (/^sha256:[0-9a-f]{64}$/.test(v)) return v;
  if (/^[0-9a-f]{64}$/.test(v)) return `sha256:${v}`;
  return undefined;
}

/**
 * Resolve the manifest digest the resolved image must match, or `undefined`
 * when digest enforcement does not apply (finding M-6).
 *
 * Precedence:
 *  1. `JAIPH_DOCKER_IMAGE_DIGEST` (operator, trusted) — a malformed value is a
 *     hard error, never silently ignored, so a typo cannot fail *open*.
 *  2. A digest embedded in the image reference itself (`repo@sha256:…`).
 *  3. The release-baked `RUNTIME_IMAGE_DIGEST`, but only for the default
 *     official image the operator did not override. A custom operator image
 *     (`JAIPH_DOCKER_IMAGE`) is that operator's supply-chain responsibility;
 *     they pin it via the digest env var or an `@sha256:` reference.
 */
export function resolveExpectedDigest(
  image: string,
  imageExplicit: boolean,
  env: Record<string, string | undefined>,
): string | undefined {
  const override = env.JAIPH_DOCKER_IMAGE_DIGEST;
  if (override !== undefined && override.trim().length > 0) {
    const d = normalizeImageDigest(override);
    if (!d) {
      throw new Error(
        `E_DOCKER_DIGEST JAIPH_DOCKER_IMAGE_DIGEST must be a sha256 digest ` +
          `('sha256:<64 hex>' or a bare 64-hex digest), got "${override}"`,
      );
    }
    return d;
  }
  const at = image.indexOf("@");
  if (at !== -1) {
    const embedded = normalizeImageDigest(image.slice(at + 1));
    if (embedded) return embedded;
  }
  if (!imageExplicit && imageRepoName(image) === GHCR_IMAGE_REPO) {
    return normalizeImageDigest(RUNTIME_IMAGE_DIGEST);
  }
  return undefined;
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

  // image: host-controlled (env) only when Docker is the active sandbox. A
  // repo- or model-supplied entry file must not point the sandbox at an
  // arbitrary image (finding M-6), so a file-declared runtime.docker_image is
  // rejected unless the operator set JAIPH_DOCKER_IMAGE (trusted). When Docker
  // is off (host / unsafe mode) the image is inert, so resolution stays lenient
  // to preserve host-mode parity.
  if (enabled && env.JAIPH_DOCKER_IMAGE === undefined && inFile?.dockerImage !== undefined) {
    throw new Error(
      `E_DOCKER_IMAGE_HOST_ONLY runtime.docker_image is host-controlled and cannot be set from the entry file; ` +
        `set the image via the JAIPH_DOCKER_IMAGE environment variable (operator-controlled).`,
    );
  }
  const imageExplicit = env.JAIPH_DOCKER_IMAGE !== undefined;
  const image = env.JAIPH_DOCKER_IMAGE ?? inFile?.dockerImage ?? DEFAULTS.image;

  // network: host-controlled (env) > host-safe in-file value > default, enforced
  // only when Docker is the active sandbox. The operator's JAIPH_DOCKER_NETWORK
  // is trusted and used verbatim (it may even be `host`). A file-declared value
  // is untrusted: `host` / `container:*` / `ns:*` would gut the sandbox network
  // isolation and are rejected unless the operator opted in via env. Inert (and
  // therefore left lenient) when Docker is off.
  if (
    enabled &&
    env.JAIPH_DOCKER_NETWORK === undefined &&
    inFile?.dockerNetwork !== undefined &&
    !isHostSafeInFileNetwork(inFile.dockerNetwork)
  ) {
    throw new Error(
      `E_DOCKER_NETWORK_HOST_ONLY runtime.docker_network "${inFile.dockerNetwork}" is not permitted from the entry file ` +
        `(host / container:* / ns:* dissolve the sandbox network isolation); ` +
        `set it via the JAIPH_DOCKER_NETWORK environment variable (operator-controlled) if you truly need it.`,
    );
  }
  const network = env.JAIPH_DOCKER_NETWORK ?? inFile?.dockerNetwork ?? DEFAULTS.network;

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

  // digest: enforced only when Docker is the active sandbox. Inert (and left
  // unresolved, so a malformed override cannot throw) in host / unsafe mode, to
  // preserve host-mode parity with the image/network keys above.
  const expectedDigest = enabled ? resolveExpectedDigest(image, imageExplicit, env) : undefined;

  return { enabled, image, imageExplicit, network, timeoutSeconds, expectedDigest };
}
