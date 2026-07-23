#!/usr/bin/env node
// Regenerates docs/registry from the upstream jaiphlang/registry index.
//
// Usage: node scripts/build-registry.mjs [source]
//   source defaults to JAIPH_REGISTRY_SOURCE if set, otherwise the upstream
//   raw URL; argv wins over env.
//
// The fetched document is written to a sibling tmp file, validated through
// the built loadRegistryIndex (imported from dist/ — run `npm run build`
// first), then renamed onto docs/registry. On any failure (unreachable
// source, invalid JSON, schema mismatch) the script exits non-zero and
// leaves docs/registry untouched.
//
// Importable: scripts/build-registry.test.mjs imports `buildRegistry` to
// exercise the contract against local fixtures without spawning a process.

import { readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const OUT_PATH = resolve(ROOT, "docs/registry");
const DEFAULT_SOURCE = "https://raw.githubusercontent.com/jaiphlang/registry/main/registry.json";

function resolveSource(argv, env) {
  if (argv.length > 0) return argv[0];
  if (env.JAIPH_REGISTRY_SOURCE && env.JAIPH_REGISTRY_SOURCE.length > 0) {
    return env.JAIPH_REGISTRY_SOURCE;
  }
  return DEFAULT_SOURCE;
}

async function readSource(source) {
  if (source.startsWith("file://")) {
    return readFileSync(fileURLToPath(source), "utf8");
  }
  if (!source.includes("://")) {
    return readFileSync(source, "utf8");
  }
  const res = await fetch(source);
  if (!res.ok) {
    throw new Error(`failed to fetch ${source}: HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * Fetch `source`, validate via `loadRegistryIndex`, write to `outPath`.
 * On any failure throws without touching `outPath`.
 */
export async function buildRegistry({ source, outPath, loadRegistryIndex }) {
  const text = await readSource(source);
  const tmpPath = `${outPath}.tmp-build-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, text);
  try {
    await loadRegistryIndex(tmpPath);
    renameSync(tmpPath, outPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    // Strip the internal tmp path from the validator's message so the user sees
    // the source they actually passed in.
    const msg = (err && err.message ? err.message : String(err)).split(tmpPath).join(source);
    const wrapped = new Error(msg);
    if (err && err.stack) wrapped.stack = err.stack;
    throw wrapped;
  }
  return { source, outPath, bytes: Buffer.byteLength(text) };
}

function isUpstreamFetchFailure(err, source, defaultSource) {
  const msg = err && err.message ? err.message : String(err);
  return source === defaultSource && msg.includes("failed to fetch");
}

/**
 * Like `buildRegistry`, but when the default upstream URL is unreachable and
 * `outPath` already contains a valid index, keep the shipped file instead of
 * failing release prep (the separate jaiphlang/registry repo may not exist yet).
 */
export async function buildRegistryOrKeepShipped({
  source,
  outPath,
  loadRegistryIndex,
  defaultSource = DEFAULT_SOURCE,
}) {
  try {
    return await buildRegistry({ source, outPath, loadRegistryIndex });
  } catch (err) {
    if (!isUpstreamFetchFailure(err, source, defaultSource) || !existsSync(outPath)) {
      throw err;
    }
    await loadRegistryIndex(outPath);
    return {
      source: outPath,
      outPath,
      bytes: readFileSync(outPath).byteLength,
      kept: true,
    };
  }
}

async function main() {
  const source = resolveSource(process.argv.slice(2), process.env);
  const require = createRequire(import.meta.url);
  const distPath = resolve(ROOT, "dist/src/cli/commands/registry.js");
  let loadRegistryIndex;
  try {
    ({ loadRegistryIndex } = require(distPath));
  } catch (err) {
    process.stderr.write(
      `build-registry: cannot load ${distPath} — run \`npm run build\` first (${err.message})\n`,
    );
    process.exit(1);
  }
  try {
    const result = await buildRegistryOrKeepShipped({
      source,
      outPath: OUT_PATH,
      loadRegistryIndex,
    });
    if (result.kept) {
      process.stderr.write(
        `build-registry: upstream unavailable; kept validated ${result.outPath} (${result.bytes} bytes)\n`,
      );
      return;
    }
    process.stdout.write(`wrote ${result.outPath} (${result.bytes} bytes) from ${result.source}\n`);
  } catch (err) {
    process.stderr.write(`build-registry: ${err.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
