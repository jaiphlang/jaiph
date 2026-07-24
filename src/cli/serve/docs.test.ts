import test from "node:test";
import assert from "node:assert/strict";
import { DOCS_HTML, SWAGGER_UI_VERSION } from "./docs";

test("the /docs shell pins an exact swagger-ui-dist version on both assets", () => {
  // The version constant is an exact pin (no ^/~/latest), and both asset URLs
  // embed it.
  assert.match(SWAGGER_UI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(
    DOCS_HTML.includes(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`),
    "bundle URL pins the exact version",
  );
  assert.ok(
    DOCS_HTML.includes(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css`),
    "css URL pins the exact version",
  );
  assert.ok(!/swagger-ui-dist@(latest|\^|~)/.test(DOCS_HTML), "no floating version range");
});

test("both the JS and CSS assets carry integrity + crossorigin attributes", () => {
  // Extract each <script>/<link> tag and assert it has both SRI + crossorigin.
  const jsTag = DOCS_HTML.slice(DOCS_HTML.indexOf("<script"), DOCS_HTML.indexOf("</script>"));
  const cssTag = DOCS_HTML.slice(DOCS_HTML.indexOf("<link"), DOCS_HTML.indexOf("/>", DOCS_HTML.indexOf("<link")) + 2);

  for (const [name, tag] of [
    ["bundle script", jsTag],
    ["css link", cssTag],
  ] as const) {
    assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+"/, `${name} has an sha384 integrity hash`);
    assert.match(tag, /crossorigin="anonymous"/, `${name} has crossorigin="anonymous"`);
  }
});

test("the shell initializes SwaggerUIBundle against /openapi.json with persistAuthorization", () => {
  assert.match(DOCS_HTML, /SwaggerUIBundle\(/);
  assert.match(DOCS_HTML, /url:\s*"\/openapi\.json"/);
  assert.match(DOCS_HTML, /persistAuthorization:\s*true/);
});
