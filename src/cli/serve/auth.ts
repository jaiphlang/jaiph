import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from "jose";

/**
 * Authentication and authorization for `jaiph serve` (REST + MCP Streamable
 * HTTP). Two production modes plus an open loopback-dev mode:
 *
 * - **none** — no `JAIPH_SERVE_TOKEN` and no OIDC config. Every caller is the
 *   `anonymous` principal with all capabilities. This is the loopback default
 *   (binding a non-loopback host in this mode is already a startup error).
 * - **static** — `JAIPH_SERVE_TOKEN` is a single shared secret. It is a
 *   **single-operator** gate: the one `operator` principal holds every
 *   capability and can inspect/cancel every run. It is NOT multi-tenant
 *   authentication — there is no per-user identity, revocation, or per-action
 *   authorization. Use OIDC for that.
 * - **oidc** — a standard OIDC/JWT bearer. Tokens are verified against the
 *   issuer's JWKS (a maintained JWT library, `jose`, does the crypto: signature,
 *   `exp`/`nbf`, `aud`, `iss`, and `kid` selection with unknown-key refetch).
 *   The principal identity is the token `sub`, falling back to `client_id` for
 *   `sub`-less machine tokens; a verified token carrying neither is rejected
 *   (never a shared constant — finding M-9). Its capabilities come from OAuth
 *   scopes (`jaiph:invoke` / `jaiph:inspect` / `jaiph:cancel`); it may
 *   inspect/cancel only the runs it created.
 */

/** A distinct action a principal may be authorized for. */
export type Capability = "invoke" | "inspect" | "cancel";

/** Every capability — held by the single operator and the open-mode principal. */
export const ALL_CAPABILITIES: readonly Capability[] = ["invoke", "inspect", "cancel"];

/** OAuth scope string that grants each capability. */
const SCOPE_FOR: Record<string, Capability> = {
  "jaiph:invoke": "invoke",
  "jaiph:inspect": "inspect",
  "jaiph:cancel": "cancel",
};

/**
 * An authenticated (or anonymous) caller. `subject` is the stable audit
 * identity — never a token — persisted to run metadata and written to audit
 * logs, OTLP resource attributes, and Sentry tags.
 */
export interface Principal {
  /** Audit identity: JWT `sub` else `client_id` (oidc), `operator` (static), `anonymous` (open). */
  subject: string;
  /** Actions this principal is authorized for. */
  capabilities: Set<Capability>;
  /**
   * When true the principal may inspect/cancel every run (the single operator
   * and the open-mode caller); when false it is scoped to runs it created.
   */
  ownsAllRuns: boolean;
}

/** A successful authentication. */
export interface AuthOk {
  ok: true;
  principal: Principal;
}

/** A failed authentication — carries the HTTP status/error shape to return. */
export interface AuthFail {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type AuthResult = AuthOk | AuthFail;

export interface Authenticator {
  /** `false` only in open mode (no token, no OIDC) — used for startup logging. */
  readonly enabled: boolean;
  /** Mode label for the startup banner. */
  readonly mode: "none" | "static" | "oidc";
  /** Verify a request's `Authorization` header into a principal or a failure. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthResult>;
}

/** OIDC/JWT mode configuration, resolved from env at startup. */
export interface OidcConfig {
  /** Expected `iss` claim and (unless `jwksUri` is set) the discovery base. */
  issuer: string;
  /** Expected `aud` claim. */
  audience: string;
  /** JWKS URI; when absent it is discovered from the issuer's well-known doc. */
  jwksUri?: string;
}

export interface AuthConfig {
  /** Static single-operator shared secret (`JAIPH_SERVE_TOKEN`). */
  token?: string;
  /** OIDC/JWT mode; takes precedence over `token` when both are set. */
  oidc?: OidcConfig;
}

/** The open-mode principal: anonymous, all capabilities, sees every run. */
export function openPrincipal(): Principal {
  return { subject: "anonymous", capabilities: new Set(ALL_CAPABILITIES), ownsAllRuns: true };
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Map a verified JWT's scope claims to capabilities. Reads the standard OAuth
 * `scope` (space-delimited string) and the `scp` (array) claim; unknown scopes
 * are ignored. A token with none of the `jaiph:*` scopes gets no capability, so
 * every action is refused (403) — the insufficient-scope contract.
 */
/**
 * Derive the stable audit/isolation identity from a verified token. Prefer the
 * standard `sub`; fall back to `client_id` (OAuth2 client-credentials / machine
 * tokens commonly omit `sub`). Returns `null` when neither is a non-empty
 * string — such a token is rejected rather than collapsed onto a shared
 * constant, so two distinct callers can never share a run-visibility bucket or
 * idempotency namespace (finding M-9).
 */
export function principalSubject(payload: JWTPayload): string | null {
  if (typeof payload.sub === "string" && payload.sub.length > 0) return payload.sub;
  const clientId = (payload as Record<string, unknown>).client_id;
  if (typeof clientId === "string" && clientId.length > 0) return clientId;
  return null;
}

export function capabilitiesFromClaims(payload: JWTPayload): Set<Capability> {
  const caps = new Set<Capability>();
  const raw: string[] = [];
  if (typeof payload.scope === "string") raw.push(...payload.scope.split(/\s+/));
  const scp = (payload as Record<string, unknown>).scp;
  if (Array.isArray(scp)) for (const s of scp) if (typeof s === "string") raw.push(s);
  for (const s of raw) {
    const cap = SCOPE_FOR[s];
    if (cap) caps.add(cap);
  }
  return caps;
}

function unauthorized(message: string): AuthFail {
  return { ok: false, status: 401, code: "E_UNAUTHORIZED", message };
}

/** Static single-operator authenticator: one shared secret, all capabilities. */
function createStaticAuthenticator(token: string): Authenticator {
  const expected = Buffer.from(token);
  return {
    enabled: true,
    mode: "static",
    authenticate(header): Promise<AuthResult> {
      const provided = bearerToken(header);
      if (provided === null) return Promise.resolve(unauthorized("missing bearer token"));
      const providedBuf = Buffer.from(provided);
      // Constant-time compare; length mismatch is short-circuited (timingSafeEqual throws on it).
      const ok = providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
      if (!ok) return Promise.resolve(unauthorized("invalid bearer token"));
      return Promise.resolve({
        ok: true,
        principal: { subject: "operator", capabilities: new Set(ALL_CAPABILITIES), ownsAllRuns: true },
      });
    },
  };
}

/** Discover the JWKS URI from the issuer's OpenID configuration document. */
async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${url} returned ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== "string" || doc.jwks_uri.length === 0) {
    throw new Error(`OIDC discovery document at ${url} has no jwks_uri`);
  }
  return doc.jwks_uri;
}

/**
 * Map a `jose` verification error to the HTTP failure shape. Expired,
 * wrong-audience/issuer, unknown-key, and bad-signature tokens are all client
 * errors (401 with a distinguishing code/message); a JWKS fetch/timeout is a
 * server-side dependency failure (503) so a client is not told its valid token
 * is invalid when the IdP is unreachable.
 */
function mapVerifyError(err: unknown): AuthFail {
  if (err instanceof joseErrors.JWTExpired) {
    return { ok: false, status: 401, code: "E_TOKEN_EXPIRED", message: "token has expired" };
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return { ok: false, status: 401, code: "E_TOKEN_INVALID", message: `token claim "${err.claim}" is invalid` };
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return { ok: false, status: 401, code: "E_TOKEN_INVALID", message: "token signed by an unknown key" };
  }
  if (err instanceof joseErrors.JWKSTimeout) {
    return { ok: false, status: 503, code: "E_AUTH_UNAVAILABLE", message: "identity provider key set is unavailable" };
  }
  if (err instanceof joseErrors.JOSEError) {
    return { ok: false, status: 401, code: "E_TOKEN_INVALID", message: "token verification failed" };
  }
  // A non-jose error means the JWKS could not be fetched/discovered.
  return { ok: false, status: 503, code: "E_AUTH_UNAVAILABLE", message: "identity provider is unavailable" };
}

/** OIDC/JWT authenticator. JWKS is resolved lazily and cached (with refetch on unknown kid). */
function createOidcAuthenticator(cfg: OidcConfig): Authenticator {
  type Jwks = ReturnType<typeof createRemoteJWKSet>;
  let jwks: Jwks | undefined;
  let pending: Promise<Jwks> | undefined;

  async function resolveJwks(): Promise<Jwks> {
    if (jwks) return jwks;
    if (!pending) {
      pending = (async (): Promise<Jwks> => {
        const uri = cfg.jwksUri ?? (await discoverJwksUri(cfg.issuer));
        const set = createRemoteJWKSet(new URL(uri));
        jwks = set;
        return set;
      })().catch((err) => {
        // Let the next request retry discovery rather than caching the failure.
        pending = undefined;
        throw err;
      });
    }
    return pending;
  }

  return {
    enabled: true,
    mode: "oidc",
    async authenticate(header): Promise<AuthResult> {
      const token = bearerToken(header);
      if (token === null) return unauthorized("missing bearer token");
      let keys: Jwks;
      try {
        keys = await resolveJwks();
      } catch (err) {
        return mapVerifyError(err);
      }
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: cfg.issuer, audience: cfg.audience });
        const subject = principalSubject(payload);
        if (subject === null) return unauthorized("token has no subject (sub/client_id) to identify the caller");
        return {
          ok: true,
          principal: { subject, capabilities: capabilitiesFromClaims(payload), ownsAllRuns: false },
        };
      } catch (err) {
        return mapVerifyError(err);
      }
    },
  };
}

/**
 * Build the authenticator for the resolved config. OIDC wins over a static
 * token when both are present; with neither, open mode (anonymous, all
 * capabilities) is returned.
 */
export function createAuthenticator(config: AuthConfig): Authenticator {
  if (config.oidc) return createOidcAuthenticator(config.oidc);
  if (config.token) return createStaticAuthenticator(config.token);
  const principal = openPrincipal();
  return {
    enabled: false,
    mode: "none",
    authenticate: () => Promise.resolve({ ok: true, principal }),
  };
}
