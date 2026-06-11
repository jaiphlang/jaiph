import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRegistry } from "./build-registry.mjs";
import { loadRegistryIndex } from "../dist/src/cli/commands/registry.js";

async function withTmp(body) {
  const dir = mkdtempSync(join(tmpdir(), "build-registry-"));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("build-registry: valid local source produces byte-identical docs/registry", async () => {
  await withTmp(async (dir) => {
    const srcText = JSON.stringify({
      libs: {
        mylib: { url: "https://example.com/mylib.git", description: "demo" },
      },
    }, null, 2) + "\n";
    const srcPath = join(dir, "registry.json");
    writeFileSync(srcPath, srcText);
    const outPath = join(dir, "registry");
    await buildRegistry({ source: srcPath, outPath, loadRegistryIndex });
    assert.equal(readFileSync(outPath, "utf8"), srcText, "output must be byte-identical to source");
  });
});

test("build-registry: invalid JSON rejects and leaves previous output untouched", async () => {
  await withTmp(async (dir) => {
    const outPath = join(dir, "registry");
    const previousText = '{"libs":{"prev":{"url":"https://example.com/prev.git","description":"prev"}}}\n';
    writeFileSync(outPath, previousText);
    const srcPath = join(dir, "registry.json");
    writeFileSync(srcPath, "{ not valid json");
    await assert.rejects(
      () => buildRegistry({ source: srcPath, outPath, loadRegistryIndex }),
      /failed to parse registry/,
    );
    assert.equal(readFileSync(outPath, "utf8"), previousText, "previous output must be untouched");
  });
});

test("build-registry: schema mismatch leaves previous output untouched", async () => {
  await withTmp(async (dir) => {
    const outPath = join(dir, "registry");
    const previousText = '{"libs":{"prev":{"url":"https://example.com/prev.git","description":"prev"}}}\n';
    writeFileSync(outPath, previousText);
    const srcPath = join(dir, "registry.json");
    // Valid JSON but wrong shape — missing required `description` on the entry.
    writeFileSync(srcPath, JSON.stringify({ libs: { bad: { url: "https://example.com/x.git" } } }));
    await assert.rejects(
      () => buildRegistry({ source: srcPath, outPath, loadRegistryIndex }),
      /missing string "description"/,
    );
    assert.equal(readFileSync(outPath, "utf8"), previousText, "previous output must be untouched");
  });
});

test("build-registry: missing source rejects and leaves previous output untouched", async () => {
  await withTmp(async (dir) => {
    const outPath = join(dir, "registry");
    const previousText = '{"libs":{"prev":{"url":"https://example.com/prev.git","description":"prev"}}}\n';
    writeFileSync(outPath, previousText);
    const missingSrc = join(dir, "does-not-exist.json");
    await assert.rejects(
      () => buildRegistry({ source: missingSrc, outPath, loadRegistryIndex }),
      /ENOENT|no such file/,
    );
    assert.equal(readFileSync(outPath, "utf8"), previousText, "previous output must be untouched");
  });
});

test("build-registry: no tmp residue alongside outPath on failure", async () => {
  await withTmp(async (dir) => {
    const outPath = join(dir, "registry");
    const previousText = "previous\n";
    writeFileSync(outPath, previousText);
    const srcPath = join(dir, "registry.json");
    writeFileSync(srcPath, "{ broken");
    await assert.rejects(() => buildRegistry({ source: srcPath, outPath, loadRegistryIndex }));
    const stale = readdirSync(dir).filter((n) => n.startsWith("registry.tmp-build-"));
    assert.deepEqual(stale, [], `stale tmp files left behind: ${stale.join(", ")}`);
    assert.equal(readFileSync(outPath, "utf8"), previousText);
  });
});
