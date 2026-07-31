import test from "node:test";
import assert from "node:assert/strict";
import {
  createAuthenticator,
  capabilitiesFromClaims,
  principalSubject,
  openPrincipal,
  oidcVerifyOptions,
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

test("principalSubject: prefers sub, falls back to client_id, else null — never a shared constant", () => {
  assert.equal(principalSubject({ sub: "alice" }), "alice");
  // sub-less machine token (OAuth2 client-credentials) → distinct per-client identity.
  assert.equal(principalSubject({ client_id: "service-a" } as Record<string, unknown>), "service-a");
  assert.equal(principalSubject({ client_id: "service-b" } as Record<string, unknown>), "service-b");
  // sub wins when both are present.
  assert.equal(principalSubject({ sub: "alice", client_id: "svc" } as Record<string, unknown>), "alice");
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
});

// === mode selection ===

test("createAuthenticator: OIDC config takes precedence over a static token", () => {
  const auth = createAuthenticator({ token: "t", oidc: { issuer: "https://issuer.example", audience: "aud" } });
  assert.equal(auth.mode, "oidc");
  assert.equal(auth.enabled, true);
});
