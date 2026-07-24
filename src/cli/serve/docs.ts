// Swagger UI is loaded from a CDN with a pinned exact version, Subresource
// Integrity (SRI) hashes, and crossorigin — never vendored/embedded, so the
// jaiph binary stays lean (embedding swagger-ui is ~1.5 MB for one page). The
// consequence, documented in docs/serve.md and the design doc: `/docs` needs
// internet access in the browser; air-gapped operators still have
// `/openapi.json`, which any locally-hosted Swagger/Redoc/Scalar renders.
//
// To bump the version: change SWAGGER_UI_VERSION and regenerate both hashes:
//   curl -s https://cdn.jsdelivr.net/npm/swagger-ui-dist@<v>/swagger-ui-bundle.js \
//     | openssl dgst -sha384 -binary | openssl base64 -A
//   curl -s https://cdn.jsdelivr.net/npm/swagger-ui-dist@<v>/swagger-ui.css \
//     | openssl dgst -sha384 -binary | openssl base64 -A
export const SWAGGER_UI_VERSION = "5.17.14";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
const BUNDLE_SRI = "sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep";
const CSS_SRI = "sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn";

/**
 * Static Swagger UI HTML shell. Loads `swagger-ui-dist` from the CDN (pinned +
 * SRI + crossorigin) and points it at `/openapi.json`. `persistAuthorization`
 * keeps the bearer token entered in the Authorize box across reloads, since a
 * browser cannot attach headers to the initial `/docs` navigation.
 */
export const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jaiph serve — API</title>
    <link
      rel="stylesheet"
      href="${CDN_BASE}/swagger-ui.css"
      integrity="${CSS_SRI}"
      crossorigin="anonymous"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script
      src="${CDN_BASE}/swagger-ui-bundle.js"
      integrity="${BUNDLE_SRI}"
      crossorigin="anonymous"
    ></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", persistAuthorization: true });
      };
    </script>
  </body>
</html>
`;
