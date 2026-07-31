import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  JAIPH_SKILL_MD_BASE64,
  SWAGGER_UI_BUNDLE_JS_BASE64,
  SWAGGER_UI_CSS_BASE64,
  decodeEmbeddedAsset,
} from "./embedded-assets";

// The standalone binary ships these files inside the executable. If they
// drift from the on-disk sources, npm builds keep working but the bun-compiled
// jaiph silently ships outdated text. Fail loudly so the next contributor
// reruns `npm run embed-assets` (run automatically by `npm run build`).
function findRepoRoot(): string {
  let cur = __dirname;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, "package.json")) && existsSync(join(cur, "runtime"))) {
      return cur;
    }
    cur = dirname(cur);
  }
  throw new Error("could not locate repo root for embedded-assets test");
}
const REPO_ROOT = findRepoRoot();

test("JAIPH_SKILL_MD_BASE64 matches docs/jaiph-skill.md on disk", () => {
  const disk = readFileSync(join(REPO_ROOT, "docs/jaiph-skill.md"), "utf8");
  assert.equal(decodeEmbeddedAsset(JAIPH_SKILL_MD_BASE64), disk);
});

// The self-hosted Swagger UI (jaiph serve /docs) ships these inside the binary.
// If they drift from the pinned swagger-ui-dist devDependency, the standalone
// jaiph would serve stale assets; fail loudly so the next build reruns embed.
test("SWAGGER_UI_*_BASE64 match the pinned swagger-ui-dist on disk", () => {
  for (const [b64, rel] of [
    [SWAGGER_UI_BUNDLE_JS_BASE64, "node_modules/swagger-ui-dist/swagger-ui-bundle.js"],
    [SWAGGER_UI_CSS_BASE64, "node_modules/swagger-ui-dist/swagger-ui.css"],
  ] as const) {
    const disk = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.equal(decodeEmbeddedAsset(b64), disk);
  }
});
