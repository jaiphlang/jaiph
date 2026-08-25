import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT, type JWK, type KeyLike } from "jose";

// End-to-end OIDC/JWT authentication + authorization for `jaiph serve`. A real
// serve process is pointed at a local JWKS server; tokens are minted here with
// `jose` so the whole validity matrix (valid / expired / wrong-audience /
// wrong-issuer / unknown-key / insufficient-scope) and the capability +
// ownership + audit contracts are exercised across the process boundary.

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");
const AUDIENCE = "jaiph-serve";

const FIXTURE = [
  "script sleeper = `sleep 1`",
  "# Greets the given name.",
  "export def greet(name) {",
  '  return "hi ${name}"',
  "}",
  "",
  "# Sleeps briefly so a run is observably in-flight.",
  "export def slow() {",
  "  run sleeper()",
  '  return "woke"',
  "}",
  "",
].join("\n");

interface Idp {
  issuer: string;
  jwksUri: string;
  /** Sign a token with the trusted key (kid `k1`). Omit `sub` to mint a machine token (optionally carrying `clientId`). */
  sign(claims: { sub?: string; scope: string; clientId?: string; issuer?: string; audience?: string; expiresInSec?: number }): Promise<string>;
  /** Sign a token with a key whose public half is NOT in the served JWKS. */
  signUnknownKey(claims: { sub: string; scope: string }): Promise<string>;
  /**
   * Sign a token with a valid asymmetric key that IS in the served JWKS but
   * whose `alg` (secp256k1 `ES256K`) is outside the server's pinned allowlist —
   * verifiable by signature yet rejected by the algorithms allowlist (L-3).
   */
  signDisallowedAlg(claims: { sub: string; scope: string }): Promise<string>;
  close(): Promise<void>;
}

/** Stand up a local OIDC identity provider: a JWKS endpoint + discovery doc. */
async function startIdp(): Promise<Idp> {
  const trusted = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  // A real asymmetric key whose `alg` is outside the server's pinned allowlist.
  const disallowed = await generateKeyPair("ES256K");
  const trustedJwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const disallowedJwk: JWK = { ...(await exportJWK(disallowed.publicKey)), kid: "k-es256k", alg: "ES256K", use: "sig" };

  let issuer = "";
  const server: Server = createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [trustedJwk, disallowedJwk] }));
      return;
    }
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;

  async function signWith(key: KeyLike, kid: string, claims: { sub?: string; scope: string; clientId?: string; issuer?: string; audience?: string; expiresInSec?: number }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (claims.expiresInSec ?? 3600);
    const jwt = new SignJWT({ scope: claims.scope, ...(claims.clientId ? { client_id: claims.clientId } : {}) })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(claims.issuer ?? issuer)
      .setAudience(claims.audience ?? AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(exp);
    if (claims.sub !== undefined) jwt.setSubject(claims.sub);
    return jwt.sign(key);
  }

  async function signDisallowedAlg(claims: { sub: string; scope: string }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: claims.scope })
      .setProtectedHeader({ alg: "ES256K", kid: "k-es256k" })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setSubject(claims.sub)
      .sign(disallowed.privateKey);
  }

  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    sign: (claims) => signWith(trusted.privateKey, "k1", claims),
    signUnknownKey: (claims) => signWith(stranger.privateKey, "unknown-kid", claims),
    signDisallowedAlg,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function serveEnv(runsRoot: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_RUNS_DIR: runsRoot,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

interface ServeProc {
  baseUrl: string;
  stderr: () => string;
  close: () => Promise<void>;
}

function startServe(fixture: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ServeProc> {
  const child = spawn("node", [CLI_PATH, "serve", "--port", "0", fixture], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start\nstderr:\n${stderrBuf}`)), 20_000);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/listening on (http:\/\/[^ ]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({
          baseUrl: m[1],
          stderr: () => stderrBuf,
          close: () =>
            new Promise<void>((res) => {
              child.on("exit", () => res());
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
            }),
        });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (code ${code})\nstderr:\n${stderrBuf}`));
    });
  });
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

test("jaiph serve OIDC: token validity matrix (valid, expired, wrong-aud, wrong-iss, unknown-key, disallowed-alg, insufficient-scope, missing)", async () => {
  const idp = await startIdp();
  const root = mkdtempSync(join(tmpdir(), "jaiph-oidc-matrix-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, FIXTURE);
  const srv = await startServe(
    jh,
    root,
    serveEnv(join(root, ".jaiph/runs"), {
      JAIPH_SERVE_OIDC_ISSUER: idp.issuer,
      JAIPH_SERVE_OIDC_AUDIENCE: AUDIENCE,
      JAIPH_SERVE_OIDC_JWKS_URI: idp.jwksUri,
    }),
  );
  const post = (token?: string): Promise<Response> =>
    fetch(`${srv.baseUrl}/v1/defs/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? bearer(token) : {}) },
      body: JSON.stringify({ name: "x" }),
    });
  try {
    const fullScope = "jaiph:invoke jaiph:inspect jaiph:cancel";

    // Valid token → the workflow runs.
    const valid = await post(await idp.sign({ sub: "alice", scope: fullScope }));
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).status, "succeeded");

    // Expired.
    const expired = await post(await idp.sign({ sub: "alice", scope: fullScope, expiresInSec: -60 }));
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, "E_TOKEN_EXPIRED");

    // Wrong audience.
    const wrongAud = await post(await idp.sign({ sub: "alice", scope: fullScope, audience: "someone-else" }));
    assert.equal(wrongAud.status, 401);
    assert.equal((await wrongAud.json()).error.code, "E_TOKEN_INVALID");

    // Wrong issuer.
    const wrongIss = await post(await idp.sign({ sub: "alice", scope: fullScope, issuer: "https://evil.example" }));
    assert.equal(wrongIss.status, 401);
    assert.equal((await wrongIss.json()).error.code, "E_TOKEN_INVALID");

    // Unknown signing key (kid not in the JWKS).
    const unknownKey = await post(await idp.signUnknownKey({ sub: "alice", scope: fullScope }));
    assert.equal(unknownKey.status, 401);
    assert.equal((await unknownKey.json()).error.code, "E_TOKEN_INVALID");

    // Valid signature by a key that IS in the JWKS, but its `alg` (ES256K) is
    // outside the pinned algorithms allowlist → rejected (finding L-3). Without
    // the allowlist this token would verify, so this guards the contract.
    const disallowedAlg = await post(await idp.signDisallowedAlg({ sub: "alice", scope: fullScope }));
    assert.equal(disallowedAlg.status, 401);
    assert.equal((await disallowedAlg.json()).error.code, "E_TOKEN_INVALID");

    // Valid signature, but no `jaiph:invoke` scope → authenticated yet forbidden.
    const insufficient = await post(await idp.sign({ sub: "alice", scope: "jaiph:inspect" }));
    assert.equal(insufficient.status, 403);
    assert.equal((await insufficient.json()).error.code, "E_FORBIDDEN");

    // No token at all.
    const missing = await post();
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, "E_UNAUTHORIZED");
  } finally {
    await srv.close();
    await idp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve OIDC: capabilities are separate, runs are per-principal, and invoke/cancel are audited without the token", async () => {
  const idp = await startIdp();
  const root = mkdtempSync(join(tmpdir(), "jaiph-oidc-authz-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, FIXTURE);
  // Discovery path: no explicit JWKS URI — the issuer's well-known doc is used.
  const srv = await startServe(
    jh,
    root,
    serveEnv(join(root, ".jaiph/runs"), {
      JAIPH_SERVE_OIDC_ISSUER: idp.issuer,
      JAIPH_SERVE_OIDC_AUDIENCE: AUDIENCE,
    }),
  );
  try {
    const aliceTok = await idp.sign({ sub: "alice", scope: "jaiph:invoke jaiph:inspect jaiph:cancel" });
    const bobTok = await idp.sign({ sub: "bob", scope: "jaiph:invoke jaiph:inspect jaiph:cancel" });
    const noCancelTok = await idp.sign({ sub: "carol", scope: "jaiph:invoke jaiph:inspect" });

    // Alice runs greet to completion.
    const created = await fetch(`${srv.baseUrl}/v1/defs/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(aliceTok) },
      body: JSON.stringify({ name: "world" }),
    });
    assert.equal(created.status, 200);
    const run = await created.json();
    assert.equal(run.status, "succeeded");
    assert.equal(run.principal, "alice", "the run records its creating principal");

    // Bob (valid, fully-scoped) cannot see or cancel Alice's run.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}`, { headers: bearer(bobTok) })).status, 404);
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/events`, { headers: bearer(bobTok) })).status, 404);
    const bobList = await (await fetch(`${srv.baseUrl}/v1/runs`, { headers: bearer(bobTok) })).json();
    assert.equal(bobList.total, 0, "bob's listing does not include alice's run");

    // Alice sees her own run.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}`, { headers: bearer(aliceTok) })).status, 200);

    // A principal without jaiph:cancel cannot cancel even its own in-flight run.
    const slowStart = await fetch(`${srv.baseUrl}/v1/defs/slow/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(noCancelTok) },
      body: "{}",
    });
    assert.equal(slowStart.status, 202);
    const slowId = (await slowStart.json()).run_id;
    const cancelDenied = await fetch(`${srv.baseUrl}/v1/runs/${slowId}/cancel`, { method: "POST", headers: bearer(noCancelTok) });
    assert.equal(cancelDenied.status, 403);
    assert.equal((await cancelDenied.json()).error.code, "E_FORBIDDEN");

    // Audit: invoke is logged with the principal on the operator start banner
    // (the collapsed per-call line: `Running <wf> run_id=… principal=…`),
    // and the raw JWT never appears.
    const logged = srv.stderr();
    assert.match(logged, /Running greet run_id=.*principal=alice/, "invoke is audited with the acting principal");
    assert.ok(!logged.includes(aliceTok), "the audit log never contains the bearer token");
  } finally {
    await srv.close();
    await idp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve OIDC: sub-less machine tokens get distinct client_id identities and cannot cross-access; a token with neither is 401 (finding M-9)", async () => {
  const idp = await startIdp();
  const root = mkdtempSync(join(tmpdir(), "jaiph-oidc-subless-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, FIXTURE);
  const srv = await startServe(
    jh,
    root,
    serveEnv(join(root, ".jaiph/runs"), {
      JAIPH_SERVE_OIDC_ISSUER: idp.issuer,
      JAIPH_SERVE_OIDC_AUDIENCE: AUDIENCE,
      JAIPH_SERVE_OIDC_JWKS_URI: idp.jwksUri,
    }),
  );
  try {
    const fullScope = "jaiph:invoke jaiph:inspect jaiph:cancel";
    // Two OAuth2 client-credentials tokens: no `sub`, distinct `client_id`.
    const clientA = await idp.sign({ scope: fullScope, clientId: "service-a" });
    const clientB = await idp.sign({ scope: fullScope, clientId: "service-b" });

    // Client A runs greet; the run records client A's identity, never the shared "unknown".
    const created = await fetch(`${srv.baseUrl}/v1/defs/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(clientA) },
      body: JSON.stringify({ name: "world" }),
    });
    assert.equal(created.status, 200);
    const run = await created.json();
    assert.equal(run.status, "succeeded");
    assert.equal(run.principal, "service-a", "the run records its creating client_id");
    assert.notEqual(run.principal, "unknown", "no principal collapses onto the shared constant");

    // Client B (a distinct sub-less token) cannot enumerate or cancel client A's run.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}`, { headers: bearer(clientB) })).status, 404);
    const bList = await (await fetch(`${srv.baseUrl}/v1/runs`, { headers: bearer(clientB) })).json();
    assert.equal(bList.total, 0, "client B's listing does not include client A's run");
    const cancelDenied = await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/cancel`, { method: "POST", headers: bearer(clientB) });
    assert.equal(cancelDenied.status, 404, "client B cannot cancel client A's run");

    // Client A still sees its own run.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}`, { headers: bearer(clientA) })).status, 200);

    // A verified token with neither `sub` nor `client_id` is rejected — never bucketed together.
    const anon = await fetch(`${srv.baseUrl}/v1/defs/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(await idp.sign({ scope: fullScope })) },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, "E_UNAUTHORIZED");
  } finally {
    await srv.close();
    await idp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: --help documents the static token as single-operator, not multi-tenant", () => {
  const result = spawnSync("node", [CLI_PATH, "serve", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /single-operator/, "static token is documented as single-operator");
  assert.match(result.stdout, /JAIPH_SERVE_OIDC_ISSUER/, "OIDC configuration is documented");
});
