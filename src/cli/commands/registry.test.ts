import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertAllowedRemoteScheme,
  EMBEDDED_REGISTRY_PUBKEY,
  loadRegistryIndex,
  verifyMinisign,
} from "./registry";
import { makeMinisignFixture } from "./minisign-fixture";

// Compiled to dist/src/cli/commands/registry.test.js — four levels up lands at repo root.
const SHIPPED_REGISTRY = resolve(__dirname, "../../../../docs/registry");
const REPO_ROOT = resolve(__dirname, "../../../..");

test("shipped docs/registry parses through loadRegistryIndex", async () => {
  const index = await loadRegistryIndex(SHIPPED_REGISTRY);
  assert.ok(Object.keys(index.libs).length > 0, "shipped registry must list at least one lib");
});

test("shipped docs/registry pins every entry (passes requireCommit) and pins jaiphlang", async () => {
  // requireCommit rejects any shipped entry lacking a `commit` — the supply-chain
  // integrity gate. The shipped index must satisfy it, and the stdlib entry must pin.
  const index = await loadRegistryIndex(SHIPPED_REGISTRY, { requireCommit: true });
  assert.ok(index.libs.jaiphlang, "shipped registry must list the jaiphlang stdlib");
  assert.match(
    index.libs.jaiphlang!.commit ?? "",
    /^[0-9a-f]{40}$/,
    "jaiphlang entry must pin a 40-char commit",
  );
});

test("loadRegistryIndex with requireCommit rejects an entry that has no commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-requirecommit-"));
  try {
    const path = join(dir, "registry.json");
    writeFileSync(path, '{"libs":{"nopin":{"url":"https://example.com/x.git","description":"d"}}}', "utf8");
    await assert.rejects(
      () => loadRegistryIndex(path, { requireCommit: true }),
      /entry "nopin" must pin a "commit"/,
    );
    // Without requireCommit the same unpinned entry still loads (pin is optional in general).
    const index = await loadRegistryIndex(path);
    assert.ok(index.libs.nopin, "unpinned entry loads when requireCommit is off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shipped docs/registry has no Jekyll front matter and parses as JSON", () => {
  const text = readFileSync(SHIPPED_REGISTRY, "utf8");
  assert.ok(!text.trimStart().startsWith("---"), "docs/registry must not carry Jekyll front matter");
  assert.doesNotThrow(() => JSON.parse(text), "docs/registry must be valid JSON");
});

test("EMBEDDED_REGISTRY_PUBKEY is a byte-for-byte mirror of repo-root jaiph.pub", () => {
  const onDisk = readFileSync(resolve(REPO_ROOT, "jaiph.pub"), "utf8");
  assert.equal(EMBEDDED_REGISTRY_PUBKEY.trim(), onDisk.trim(), "embedded trust anchor must match jaiph.pub");
});

test("verifyMinisign accepts a valid signature and rejects tampering", () => {
  const fx = makeMinisignFixture();
  const message = Buffer.from('{"libs":{}}');
  const sig = fx.sign(message);
  assert.equal(verifyMinisign(message, sig, fx.publicKey), true, "valid signature must verify");
  assert.equal(verifyMinisign(Buffer.from("tampered"), sig, fx.publicKey), false, "tampered message must fail");
  const other = makeMinisignFixture();
  assert.equal(verifyMinisign(message, sig, other.publicKey), false, "wrong key must fail");
  assert.equal(verifyMinisign(message, "not a minisign blob", fx.publicKey), false, "garbage signature must fail closed");
});

test("assertAllowedRemoteScheme permits https/ssh/file/local and rejects http/git", () => {
  assert.doesNotThrow(() => assertAllowedRemoteScheme("https://jaiph.org/registry", "registry source"));
  assert.doesNotThrow(() => assertAllowedRemoteScheme("ssh://git@host/repo.git", "lib url"));
  assert.doesNotThrow(() => assertAllowedRemoteScheme("file:///tmp/registry", "registry source"));
  assert.doesNotThrow(() => assertAllowedRemoteScheme("git@github.com:org/repo.git", "lib url"));
  assert.doesNotThrow(() => assertAllowedRemoteScheme("/abs/local/path", "registry source"));
  assert.throws(() => assertAllowedRemoteScheme("http://jaiph.org/registry", "registry source"), /disallowed scheme "http:\/\/"/);
  assert.throws(() => assertAllowedRemoteScheme("git://github.com/org/repo.git", "lib url"), /disallowed scheme "git:\/\/"/);
});

/** Point global fetch at an in-memory map of url -> body/status for one call. Restores on return. */
async function withFetch<T>(routes: Record<string, { body?: string; status?: number }>, body: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
    if (!route) return { ok: false, status: 404, text: async () => "" } as Response;
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => route.body ?? "" } as Response;
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = orig;
  }
}

const REMOTE = "https://registry.example/registry";

test("loadRegistryIndex verifies a signed remote index (fail-closed happy path)", async () => {
  const fx = makeMinisignFixture();
  const indexText = JSON.stringify({ libs: { mylib: { url: "https://example.com/mylib.git", description: "ok" } } });
  const index = await withFetch(
    { [REMOTE]: { body: indexText }, [`${REMOTE}.minisig`]: { body: fx.sign(Buffer.from(indexText, "utf8")) } },
    () => loadRegistryIndex(REMOTE, { publicKey: fx.publicKey }),
  );
  assert.ok(index.libs.mylib, "signed remote index must load");
});

test("loadRegistryIndex rejects a tampered remote index (signature no longer matches)", async () => {
  const fx = makeMinisignFixture();
  const signedText = JSON.stringify({ libs: { mylib: { url: "https://example.com/mylib.git", description: "ok" } } });
  const tamperedText = JSON.stringify({ libs: { evil: { url: "https://evil.example/x.git", description: "pwn" } } });
  await assert.rejects(
    withFetch(
      { [REMOTE]: { body: tamperedText }, [`${REMOTE}.minisig`]: { body: fx.sign(Buffer.from(signedText, "utf8")) } },
      () => loadRegistryIndex(REMOTE, { publicKey: fx.publicKey }),
    ),
    /signature check failed/,
  );
});

test("loadRegistryIndex rejects an unsigned remote index (missing .minisig fails closed)", async () => {
  const indexText = JSON.stringify({ libs: {} });
  await assert.rejects(
    withFetch({ [REMOTE]: { body: indexText } }, () => loadRegistryIndex(REMOTE)),
    /failed to fetch registry signature/,
  );
});

test("loadRegistryIndex rejects a plain http:// remote source before fetching", async () => {
  await assert.rejects(
    loadRegistryIndex("http://registry.example/registry"),
    /disallowed scheme "http:\/\/"/,
  );
});
