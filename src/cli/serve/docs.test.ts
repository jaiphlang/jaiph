import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DOCS_HTML,
  SWAGGER_UI_VERSION,
  SWAGGER_UI_BUNDLE_JS,
  SWAGGER_UI_CSS,
  SWAGGER_UI_BUNDLE_PATH,
  SWAGGER_UI_CSS_PATH,
  SWAGGER_UI_BUNDLE_SRI,
  SWAGGER_UI_CSS_SRI,
} from "./docs";

test("the /docs shell pins an exact swagger-ui-dist version", () => {
  // The version constant is an exact pin (no ^/~/latest).
  assert.match(SWAGGER_UI_VERSION, /^\d+\.\d+\.\d+$/);
});

test("the /docs HTML loads assets from same-origin paths only — no third-party host", () => {
  // AC: no cdn.jsdelivr.net (or any other host) remains in the /docs HTML.
  assert.ok(!DOCS_HTML.includes("cdn.jsdelivr.net"), "no jsdelivr CDN reference");
  assert.ok(!/https?:\/\//.test(DOCS_HTML), "no absolute http(s) URL in the shell");

  // Every asset the shell loads is a same-origin (root-relative) path under /docs.
  const assetUrls = [...DOCS_HTML.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(assetUrls.length >= 2, "shell references at least the css + bundle");
  for (const url of assetUrls) {
    assert.ok(url.startsWith("/"), `asset URL ${url} is same-origin (root-relative)`);
  }
  assert.ok(DOCS_HTML.includes(`src="${SWAGGER_UI_BUNDLE_PATH}"`), "bundle served from /docs");
  assert.ok(DOCS_HTML.includes(`href="${SWAGGER_UI_CSS_PATH}"`), "css served from /docs");
});

test("both the JS and CSS tags carry an SRI hash matching the embedded bytes", () => {
  // First-party same-origin assets: integrity is stamped from the embedded
  // bytes (no crossorigin needed), so a mutating proxy/cache is rejected.
  const jsTag = DOCS_HTML.slice(DOCS_HTML.indexOf("<script"), DOCS_HTML.indexOf("</script>"));
  const cssTag = DOCS_HTML.slice(DOCS_HTML.indexOf("<link"), DOCS_HTML.indexOf("/>", DOCS_HTML.indexOf("<link")) + 2);
  for (const [name, tag] of [["bundle script", jsTag], ["css link", cssTag]] as const) {
    assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+"/, `${name} has an sha384 integrity hash`);
    assert.ok(!/crossorigin/.test(tag), `${name} needs no crossorigin (same-origin)`);
  }

  // The stamped hash is exactly the sha384 of the bytes handler.ts serves.
  const sri = (s: string) => "sha384-" + createHash("sha384").update(Buffer.from(s, "utf8")).digest("base64");
  assert.equal(SWAGGER_UI_BUNDLE_SRI, sri(SWAGGER_UI_BUNDLE_JS));
  assert.equal(SWAGGER_UI_CSS_SRI, sri(SWAGGER_UI_CSS));
  assert.ok(DOCS_HTML.includes(SWAGGER_UI_BUNDLE_SRI));
  assert.ok(DOCS_HTML.includes(SWAGGER_UI_CSS_SRI));
});

test("the embedded assets are the real swagger-ui-dist bundle + stylesheet", () => {
  // Non-empty and recognisably the vendored assets (so /docs actually renders).
  assert.ok(SWAGGER_UI_BUNDLE_JS.length > 100_000, "bundle is embedded");
  assert.ok(SWAGGER_UI_CSS.length > 10_000, "stylesheet is embedded");
  assert.match(SWAGGER_UI_BUNDLE_JS, /SwaggerUIBundle/);
  assert.match(SWAGGER_UI_CSS, /\.swagger-ui/);
});

test("the shell initializes SwaggerUIBundle against /openapi.json with persistAuthorization", () => {
  assert.match(DOCS_HTML, /SwaggerUIBundle\(/);
  assert.match(DOCS_HTML, /url:\s*"\/openapi\.json"/);
  assert.match(DOCS_HTML, /persistAuthorization:\s*true/);
});
