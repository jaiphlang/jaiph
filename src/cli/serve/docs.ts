// Swagger UI is self-hosted: the pinned `swagger-ui-dist` assets are embedded
// into the jaiph binary (via tools/embed-assets.js) and served from same-origin
// paths under `/docs`. `/docs` therefore renders a working Swagger UI with no
// browser internet access — air-gapped operators and CSP-locked deployments
// that block third-party hosts can invoke and inspect workflows offline. The
// assets are first-party once embedded, so each tag still carries a Subresource
// Integrity hash computed from the embedded bytes (rejecting a proxy/cache that
// mutates them in flight), but no `crossorigin` is needed for same-origin.
//
// To bump the version: change the pinned `swagger-ui-dist` devDependency in
// package.json, update SWAGGER_UI_VERSION to match, and rerun `npm run build`
// (which regenerates the embedded bytes via `npm run embed-assets`).
import { createHash } from "node:crypto";
import {
  SWAGGER_UI_BUNDLE_JS_BASE64,
  SWAGGER_UI_CSS_BASE64,
  decodeEmbeddedAsset,
} from "../../runtime";

export const SWAGGER_UI_VERSION = "5.17.14";

/** Same-origin paths the shell loads its embedded assets from. */
export const SWAGGER_UI_BUNDLE_PATH = "/docs/swagger-ui-bundle.js";
export const SWAGGER_UI_CSS_PATH = "/docs/swagger-ui.css";

/** Embedded first-party asset bytes, decoded once at module load. */
export const SWAGGER_UI_BUNDLE_JS = decodeEmbeddedAsset(SWAGGER_UI_BUNDLE_JS_BASE64);
export const SWAGGER_UI_CSS = decodeEmbeddedAsset(SWAGGER_UI_CSS_BASE64);

// SRI over the exact UTF-8 bytes the same-origin server sends (see handler.ts).
function sri(content: string): string {
  return "sha384-" + createHash("sha384").update(Buffer.from(content, "utf8")).digest("base64");
}
export const SWAGGER_UI_BUNDLE_SRI = sri(SWAGGER_UI_BUNDLE_JS);
export const SWAGGER_UI_CSS_SRI = sri(SWAGGER_UI_CSS);

/**
 * Static Swagger UI HTML shell. Loads the embedded `swagger-ui-dist` from
 * same-origin `/docs/*` paths (integrity-checked, no third-party host) and
 * points it at `/openapi.json`. `persistAuthorization` keeps the bearer token
 * entered in the Authorize box across reloads, since a browser cannot attach
 * headers to the initial `/docs` navigation.
 */
export const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jaiph serve — API</title>
    <link
      rel="stylesheet"
      href="${SWAGGER_UI_CSS_PATH}"
      integrity="${SWAGGER_UI_CSS_SRI}"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script
      src="${SWAGGER_UI_BUNDLE_PATH}"
      integrity="${SWAGGER_UI_BUNDLE_SRI}"
    ></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", persistAuthorization: true });
      };
    </script>
  </body>
</html>
`;
