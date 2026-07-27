import test from "node:test";
import assert from "node:assert/strict";
import {
  createAuthenticator,
  capabilitiesFromClaims,
  openPrincipal,
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

// === mode selection ===

test("createAuthenticator: OIDC config takes precedence over a static token", () => {
  const auth = createAuthenticator({ token: "t", oidc: { issuer: "https://issuer.example", audience: "aud" } });
  assert.equal(auth.mode, "oidc");
  assert.equal(auth.enabled, true);
});
