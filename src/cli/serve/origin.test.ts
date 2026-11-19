import test from "node:test";
import assert from "node:assert/strict";
import { checkRequestOrigin, isLoopbackBind, type OriginGuardConfig } from "./origin";

function cfg(over?: Partial<OriginGuardConfig>): OriginGuardConfig {
  return {
    boundHost: "127.0.0.1",
    boundPort: 5247,
    allowedOrigins: new Set(),
    allowedHosts: undefined,
    ...over,
  };
}

test("isLoopbackBind recognizes loopback addresses only", () => {
  for (const h of ["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1", "LOCALHOST", " 127.0.0.1 "]) {
    assert.equal(isLoopbackBind(h), true, `${h} is loopback`);
  }
  for (const h of ["0.0.0.0", "10.0.0.1", "api.example", ""]) {
    assert.equal(isLoopbackBind(h), false, `${h} is not loopback`);
  }
});

test("an absent Origin and Host pass (curl, MCP clients)", () => {
  assert.equal(checkRequestOrigin({}, cfg()), null);
});

test("a cross-origin Origin is rejected with E_FORBIDDEN_ORIGIN", () => {
  const r = checkRequestOrigin({ origin: "https://evil.example" }, cfg());
  assert.equal(r?.code, "E_FORBIDDEN_ORIGIN");
});

test("a malformed Origin is treated as cross-origin, not a pass", () => {
  assert.equal(checkRequestOrigin({ origin: "not a url" }, cfg())?.code, "E_FORBIDDEN_ORIGIN");
  // The opaque `null` origin (sandboxed iframe, file://) is not same-origin.
  assert.equal(checkRequestOrigin({ origin: "null" }, cfg())?.code, "E_FORBIDDEN_ORIGIN");
});

test("every loopback same-origin form passes on a loopback bind", () => {
  for (const origin of ["http://localhost:5247", "http://127.0.0.1:5247", "http://[::1]:5247"]) {
    assert.equal(checkRequestOrigin({ origin }, cfg()), null, `${origin} is same-origin`);
  }
});

test("an https origin on the same authority is not same-origin (server is http)", () => {
  assert.equal(checkRequestOrigin({ origin: "https://127.0.0.1:5247" }, cfg())?.code, "E_FORBIDDEN_ORIGIN");
});

test("a same-origin authority on the wrong port is rejected", () => {
  assert.equal(checkRequestOrigin({ origin: "http://127.0.0.1:9999" }, cfg())?.code, "E_FORBIDDEN_ORIGIN");
});

test("an allowlisted Origin passes verbatim", () => {
  const c = cfg({ allowedOrigins: new Set(["https://app.example"]) });
  assert.equal(checkRequestOrigin({ origin: "https://app.example" }, c), null);
});

test("Host on a loopback bind must be a loopback authority with the bound port", () => {
  for (const host of ["localhost:5247", "127.0.0.1:5247", "[::1]:5247", "LOCALHOST:5247"]) {
    assert.equal(checkRequestOrigin({ host }, cfg()), null, `${host} passes`);
  }
  for (const host of ["evil.example:5247", "localhost:9999", "127.0.0.1"]) {
    assert.equal(checkRequestOrigin({ host }, cfg())?.code, "E_FORBIDDEN_HOST", `${host} is rejected`);
  }
});

test("on a non-loopback bind the Host check is skipped unless an allowlist is set", () => {
  const open = cfg({ boundHost: "0.0.0.0", boundPort: 8080 });
  assert.equal(checkRequestOrigin({ host: "anything.example" }, open), null);

  const gated = cfg({ boundHost: "0.0.0.0", boundPort: 8080, allowedHosts: new Set(["api.example:8080"]) });
  assert.equal(checkRequestOrigin({ host: "api.example:8080" }, gated), null);
  assert.equal(checkRequestOrigin({ host: "evil.example:8080" }, gated)?.code, "E_FORBIDDEN_HOST");
});

test("on a non-loopback bind same-origin is exactly the bound authority", () => {
  const c = cfg({ boundHost: "0.0.0.0", boundPort: 8080 });
  assert.equal(checkRequestOrigin({ origin: "http://0.0.0.0:8080" }, c), null);
  assert.equal(checkRequestOrigin({ origin: "http://evil.example:8080" }, c)?.code, "E_FORBIDDEN_ORIGIN");
});

test("the Origin check runs before the Host check", () => {
  // A bad Origin with a valid Host still fails as an origin rejection.
  const r = checkRequestOrigin({ origin: "https://evil.example", host: "127.0.0.1:5247" }, cfg());
  assert.equal(r?.code, "E_FORBIDDEN_ORIGIN");
});
