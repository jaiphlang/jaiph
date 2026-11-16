import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAuthenticator,
  capabilitiesFromClaims,
  principalSubject,
  openPrincipal,
  oidcVerifyOptions,
  discoverJwksUri,
  jwksUriAllowed,
  OIDC_JWT_ALGORITHMS,
  ALL_CAPABILITIES,
  type Capability,
} from "./auth";

function sortedCaps(set: Set<Capability>): string[] {
  return [...set].sort();
}

const ALL = [...ALL_CAPABILITIES].sort();

// === open mode ===

test("open mode: no token, no OIDC → anonymous with all capabilities, owns every run", async () => {
  const auth = createAuthenticator({});
  assert.equal(auth.enabled, false);
  assert.equal(auth.mode, "none");
  const res = await auth.authenticate(undefined);
  assert.ok(res.ok);
  assert.equal(res.principal.subject, "anonymous");
  assert.deepEqual(sortedCaps(res.principal.capabilities), ALL);
  assert.equal(res.principal.ownsAllRuns, true);
});

test("openPrincipal helper matches open mode", () => {
  const p = openPrincipal();
  assert.equal(p.subject, "anonymous");
  assert.equal(p.ownsAllRuns, true);
  assert.deepEqual(sortedCaps(p.capabilities), ALL);
});

// === static single-operator token ===

test("static token: the correct bearer authenticates the operator with all capabilities and ownership", async () => {
  const auth = createAuthenticator({ token: "s3cret" });
  assert.equal(auth.enabled, true);
  assert.equal(auth.mode, "static");
  const ok = await auth.authenticate("Bearer s3cret");
  assert.ok(ok.ok);
  assert.equal(ok.principal.subject, "operator");
  assert.equal(ok.principal.ownsAllRuns, true);
  assert.deepEqual(sortedCaps(ok.principal.capabilities), ALL);
});

test("static token: missing, wrong-value, wrong-length, and non-Bearer headers are 401", async () => {
  const auth = createAuthenticator({ token: "s3cret" });
  for (const header of [undefined, "Bearer nope", "Bearer s3cret-longer", "Basic s3cret", "s3cret"]) {
    const res = await auth.authenticate(header);
    assert.equal(res.ok, false, `header ${String(header)} must fail`);
    if (!res.ok) {
      assert.equal(res.status, 401);
      assert.equal(res.code, "E_UNAUTHORIZED");
    }
  }
});

test("static token: the Bearer scheme is matched case-insensitively (RFC 7235)", async () => {
  const auth = createAuthenticator({ token: "s3cret" });
  for (const header of ["bearer s3cret", "BEARER s3cret", "BeArEr s3cret"]) {
    const res = await auth.authenticate(header);
    assert.ok(res.ok, `header ${header} must authenticate`);
    if (res.ok) assert.equal(res.principal.subject, "operator");
  }
});

test("empty JAIPH_SERVE_TOKEN fails startup instead of silently selecting open mode", () => {
  // An empty string (e.g. an unset `${VAR}` in a compose file) must fail closed.
  assert.throws(() => createAuthenticator({ token: "" }), /JAIPH_SERVE_TOKEN is set but empty/);
  // Even alongside OIDC, an empty token is surfaced rather than ignored.
  assert.throws(
    () => createAuthenticator({ token: "", oidc: { issuer: "https://issuer.example", audience: "aud" } }),
    /JAIPH_SERVE_TOKEN is set but empty/,
  );
  // An unset token (undefined) is still open mode — only an explicit empty string errors.
  assert.equal(createAuthenticator({}).mode, "none");
  assert.equal(createAuthenticator({ token: undefined }).mode, "none");
});

// === scope → capability mapping ===

test("capabilitiesFromClaims: maps jaiph:* scopes from the OAuth scope string", () => {
  assert.deepEqual(sortedCaps(capabilitiesFromClaims({ scope: "openid jaiph:invoke jaiph:inspect" })), [
    "inspect",
    "invoke",
  ]);
});

test("capabilitiesFromClaims: maps from the scp array claim and ignores unknown scopes", () => {
  assert.deepEqual(sortedCaps(capabilitiesFromClaims({ scp: ["jaiph:cancel", "other:thing"] })), ["cancel"]);
});

test("capabilitiesFromClaims: a token with no jaiph scopes yields no capabilities (insufficient scope)", () => {
  assert.deepEqual(sortedCaps(capabilitiesFromClaims({ scope: "openid profile" })), []);
  assert.deepEqual(sortedCaps(capabilitiesFromClaims({})), []);
});

// === principal identity (finding M-9) ===

test("principalSubject: namespaces by claim type (sub:/client_id:), prefers sub, else null — never a raw or shared constant", () => {
  // The identity is namespaced by claim type, never the raw claim text.
  assert.equal(principalSubject({ sub: "alice" }), "sub:alice");
  // sub-less machine token (OAuth2 client-credentials) → distinct per-client identity.
  assert.equal(principalSubject({ client_id: "service-a" } as Record<string, unknown>), "client_id:service-a");
  assert.equal(principalSubject({ client_id: "service-b" } as Record<string, unknown>), "client_id:service-b");
  // sub wins when both are present.
  assert.equal(principalSubject({ sub: "alice", client_id: "svc" } as Record<string, unknown>), "sub:alice");
  // A `sub` and a `client_id` with the same raw value are distinct principals.
  assert.notEqual(
    principalSubject({ sub: "alice" }),
    principalSubject({ client_id: "alice" } as Record<string, unknown>),
  );
  // A verified subject can never equal the static/open sentinels.
  assert.equal(principalSubject({ sub: "operator" }), "sub:operator");
  assert.notEqual(principalSubject({ sub: "operator" }), "operator");
  assert.equal(principalSubject({ sub: "anonymous" }), "sub:anonymous");
  assert.notEqual(principalSubject({ sub: "anonymous" }), "anonymous");
  // Neither claim → no identity; the caller is rejected, never bucketed together.
  assert.equal(principalSubject({}), null);
  assert.equal(principalSubject({ sub: "" }), null);
  assert.equal(principalSubject({ sub: "", client_id: "" } as Record<string, unknown>), null);
  // The removed shared fallback must never come back for isolation purposes.
  assert.notEqual(principalSubject({}), "unknown");
});

// === OIDC verify options: pinned algorithms allowlist (finding L-3) ===

test("oidcVerifyOptions: pins issuer, audience, and a non-empty asymmetric algorithms allowlist", () => {
  const opts = oidcVerifyOptions({ issuer: "https://issuer.example", audience: "aud" });
  assert.equal(opts.issuer, "https://issuer.example");
  assert.equal(opts.audience, "aud");
  // The options object must carry a non-empty algorithms allowlist.
  assert.ok(Array.isArray(opts.algorithms), "options include an algorithms allowlist");
  assert.ok(opts.algorithms!.length > 0, "the algorithms allowlist is non-empty");
  // The supported asymmetric algorithms are present (at least RS256 and ES256).
  assert.ok(opts.algorithms!.includes("RS256"), "RS256 is allowed");
  assert.ok(opts.algorithms!.includes("ES256"), "ES256 is allowed");
  // Symmetric algorithms, alg:none, and the non-recommended secp256k1 curve must never be allowed.
  for (const banned of ["HS256", "HS384", "HS512", "none", "ES256K"]) {
    assert.ok(!opts.algorithms!.includes(banned), `${banned} must not be in the allowlist`);
  }
  // The returned array is a copy, not the shared constant (jose must not mutate the source of truth).
  assert.notEqual(opts.algorithms, OIDC_JWT_ALGORITHMS);
  assert.deepEqual(opts.algorithms, [...OIDC_JWT_ALGORITHMS]);
  // `exp` is required so a signed token with no expiry is rejected, not accepted forever.
  assert.deepEqual(opts.requiredClaims, ["exp"]);
});

// === JWKS discovery hardening ===

test("jwksUriAllowed: requires https unless the issuer is loopback HTTP", () => {
  // https is always fine.
  assert.equal(jwksUriAllowed("https://idp.example/jwks", "https://idp.example"), true);
  // A plain-HTTP jwks_uri for a non-loopback issuer is rejected (swappable in transit).
  assert.equal(jwksUriAllowed("http://idp.example/jwks", "https://idp.example"), false);
  // Loopback HTTP issuers (test fixtures) may serve an http jwks_uri.
  assert.equal(jwksUriAllowed("http://127.0.0.1:1234/jwks", "http://127.0.0.1:1234"), true);
  assert.equal(jwksUriAllowed("http://localhost/jwks", "http://localhost"), true);
  // A loopback jwks_uri does NOT excuse a non-loopback issuer.
  assert.equal(jwksUriAllowed("http://127.0.0.1/jwks", "http://idp.example"), false);
});

/**
 * Stand up a one-shot discovery endpoint. The document is built from the
 * server's own issuer URL via `makeDoc` so a matching-issuer case does not have
 * to guess the port in advance.
 */
function startDiscovery(makeDoc: (issuer: string) => unknown): Promise<{ issuer: string; close: () => Promise<void> }> {
  let issuer = "";
  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(makeDoc(issuer)));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        issuer,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("discoverJwksUri: returns the jwks_uri when the document's issuer matches", async () => {
  const d = await startDiscovery((issuer) => ({ issuer, jwks_uri: `${issuer}/jwks` }));
  try {
    assert.equal(await discoverJwksUri(d.issuer), `${d.issuer}/jwks`);
  } finally {
    await d.close();
  }
});

test("discoverJwksUri: a document issuer that does not match the configured issuer fails", async () => {
  const d = await startDiscovery((issuer) => ({ issuer: "https://evil.example", jwks_uri: `${issuer}/jwks` }));
  try {
    await assert.rejects(discoverJwksUri(d.issuer), /has issuer "https:\/\/evil\.example", expected/);
  } finally {
    await d.close();
  }
});

// The http-jwks-rejection branch inside discoverJwksUri only fires for a
// non-loopback issuer, which cannot be reached by a loopback test server; the
// `jwksUriAllowed` test above is the direct coverage for that gate.

test("discoverJwksUri: a stalled discovery server trips the timeout and fails startup", async () => {
  const server: Server = createServer(() => {
    /* never responds — the request hangs until the abort timeout fires */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(discoverJwksUri(issuer, 50));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// === mode selection ===

test("createAuthenticator: OIDC config takes precedence over a static token", () => {
  const auth = createAuthenticator({ token: "t", oidc: { issuer: "https://issuer.example", audience: "aud" } });
  assert.equal(auth.mode, "oidc");
  assert.equal(auth.enabled, true);
});
