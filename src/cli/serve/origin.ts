/**
 * Cross-origin / Host-header guard for `jaiph serve`, kept out of the router so
 * it is a pure, unit-testable function with no socket or handler state.
 *
 * Two browser-reachable attacks motivate it (the MCP Streamable HTTP spec
 * mandates Origin validation; DNS rebinding motivates the Host check): a page on
 * another origin issuing a no-preflight `fetch` to the loopback server, and a
 * hostile DNS name that resolves to 127.0.0.1 so the browser treats the loopback
 * server as the attacker's own origin. The first is caught by validating the
 * `Origin` header, the second by validating the `Host` header.
 */

/** Resolved guard config, derived once per request from the bound address + allowlists. */
export interface OriginGuardConfig {
  /** The address `jaiph serve` bound (`--host`). */
  boundHost: string;
  /** The port actually bound (resolved after listen; `--port 0` → the real one). */
  boundPort: number;
  /** Extra exact origins allowed beyond same-origin (`JAIPH_SERVE_ALLOWED_ORIGINS`). */
  allowedOrigins: Set<string>;
  /**
   * Extra `Host` authorities (lowercased `host:port`) allowed on a non-loopback
   * bind (`JAIPH_SERVE_ALLOWED_HOSTS`). `undefined` skips the Host check on a
   * non-loopback bind; it never relaxes the loopback check.
   */
  allowedHosts?: Set<string>;
}

/** A 403 reason returned by the guard; `null` means the request may proceed. */
export interface OriginRejection {
  code: string;
  message: string;
}

/** True when `host` (the bound `--host`) is a loopback address. */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

/** The `host:port` authorities a loopback server answers to (lowercased). */
function loopbackAuthorities(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

/** The authorities that count as this server's own origin host (lowercased). */
function selfAuthorities(cfg: OriginGuardConfig): Set<string> {
  if (isLoopbackBind(cfg.boundHost)) return loopbackAuthorities(cfg.boundPort);
  return new Set([`${cfg.boundHost.trim().toLowerCase()}:${cfg.boundPort}`]);
}

function crossOrigin(originHeader: string): OriginRejection {
  return { code: "E_FORBIDDEN_ORIGIN", message: `cross-origin request from Origin "${originHeader}" is not allowed` };
}

/**
 * Validate the `Origin` header. Absent (curl, MCP clients) passes. Present and
 * same-origin (an `http://` origin whose authority is this server's) or exactly
 * in the allowlist passes; anything else is cross-origin and is rejected.
 */
function checkOrigin(originHeader: string | undefined, cfg: OriginGuardConfig): OriginRejection | null {
  if (originHeader === undefined) return null;
  const origin = originHeader.trim();
  if (cfg.allowedOrigins.has(origin)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return crossOrigin(originHeader);
  }
  // The server speaks plain HTTP, so only an http:// origin on one of its own
  // authorities is same-origin. A TLS-terminating proxy uses the allowlist.
  if (url.protocol === "http:" && selfAuthorities(cfg).has(url.host.toLowerCase())) return null;
  return crossOrigin(originHeader);
}

/**
 * Validate the `Host` header. On a loopback bind the authority must be a
 * loopback name with the bound port; on a non-loopback bind it is checked only
 * when `allowedHosts` is configured. An absent header (pre-HTTP/1.1 only in
 * practice) passes — the browser attacks this defends against always send one.
 */
function checkHost(hostHeader: string | undefined, cfg: OriginGuardConfig): OriginRejection | null {
  if (hostHeader === undefined) return null;
  const host = hostHeader.trim().toLowerCase();
  if (isLoopbackBind(cfg.boundHost)) {
    if (loopbackAuthorities(cfg.boundPort).has(host)) return null;
    return {
      code: "E_FORBIDDEN_HOST",
      message: `Host "${hostHeader}" is not allowed; expected a loopback host on port ${cfg.boundPort}`,
    };
  }
  if (!cfg.allowedHosts) return null;
  if (cfg.allowedHosts.has(host)) return null;
  return { code: "E_FORBIDDEN_HOST", message: `Host "${hostHeader}" is not in JAIPH_SERVE_ALLOWED_HOSTS` };
}

/**
 * The single guard the router calls before routing any request: reject a
 * cross-origin `Origin` or a wrong `Host`, else return `null` to proceed.
 */
export function checkRequestOrigin(
  headers: Record<string, string | undefined>,
  cfg: OriginGuardConfig,
): OriginRejection | null {
  return checkOrigin(headers["origin"], cfg) ?? checkHost(headers["host"], cfg);
}
