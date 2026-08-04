import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@seriousme/openapi-schema-validator";
import { parsejaiph } from "../../parser";
import { deriveTools, type McpToolSpec } from "../shared/mcp-tools";
import { buildOpenApi } from "./openapi";

const FILE = "/ws/tools.jh";

function toolsFrom(source: string): McpToolSpec[] {
  return deriveTools(parsejaiph(source, FILE), FILE).tools;
}

const SERVER_INFO = { title: "jaiph — tools.jh", version: "9.9.9" };

// An export-narrowing fixture: only `alpha` is exported, so `beta` is not a tool.
const EXPORT_NARROWED = [
  "# Alpha does A.",
  "export workflow alpha(name) {",
  '  return "a ${name}"',
  "}",
  "",
  "# Beta does B (not exported).",
  "workflow beta() {",
  '  return "b"',
  "}",
  "",
].join("\n");

test("buildOpenApi produces a document that passes a real OpenAPI 3.1 validator", async () => {
  const doc = buildOpenApi(toolsFrom(EXPORT_NARROWED), SERVER_INFO);
  const validator = new Validator();
  const result = await validator.validate(doc);
  assert.equal(result.valid, true, `OpenAPI validation failed: ${JSON.stringify(result.errors)}`);
  assert.equal(validator.version, "3.1");
});

test("buildOpenApi emits one path per exposed workflow, honoring export narrowing", () => {
  const tools = toolsFrom(EXPORT_NARROWED);
  assert.deepEqual(tools.map((t) => t.name), ["alpha"]);

  const doc = buildOpenApi(tools, SERVER_INFO) as any;
  const workflowPaths = Object.keys(doc.paths).filter((p) => /^\/v1\/workflows\/[^/]+\/runs$/.test(p));
  assert.deepEqual(workflowPaths, ["/v1/workflows/alpha/runs"], "exactly one workflow path; beta is not exposed");
  assert.equal(doc.paths["/v1/workflows/beta/runs"], undefined);
});

test("each workflow path carries the exact MCP-derived input schema as its JSON request body", () => {
  const tools = toolsFrom(EXPORT_NARROWED);
  const doc = buildOpenApi(tools, SERVER_INFO) as any;
  const op = doc.paths["/v1/workflows/alpha/runs"].post;
  assert.equal(op.operationId, "run_alpha");
  assert.deepEqual(op.requestBody.content["application/json"].schema, tools[0].inputSchema);
  // Bearer security is applied to the workflow operation.
  assert.deepEqual(op.security, [{ bearer: [] }]);
});

test("the document pins info + bearer scheme + run/error component schemas", () => {
  const doc = buildOpenApi(toolsFrom(EXPORT_NARROWED), SERVER_INFO) as any;
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(doc.info, { title: "jaiph — tools.jh", version: "9.9.9" });
  assert.deepEqual(doc.components.securitySchemes.bearer, { type: "http", scheme: "bearer" });
  assert.ok(doc.components.schemas.Run, "Run schema present");
  assert.ok(doc.components.schemas.Error, "Error schema present");
  // Static run-resource paths are present.
  for (const p of ["/v1/workflows", "/v1/runs", "/v1/runs/{id}", "/v1/runs/{id}/cancel", "/healthz"]) {
    assert.ok(doc.paths[p], `path ${p} present`);
  }
});

test("buildOpenApi validates for a multi-tool (no-export) module too", async () => {
  const tools = toolsFrom(
    ["# Build.", "workflow build(target) {", '  return "${target}"', "}", "", "# Deploy.", "workflow deploy() {", '  return "ok"', "}", ""].join("\n"),
  );
  assert.deepEqual(tools.map((t) => t.name).sort(), ["build", "deploy"]);
  const doc = buildOpenApi(tools, SERVER_INFO);
  const result = await new Validator().validate(doc);
  assert.equal(result.valid, true, `validation failed: ${JSON.stringify(result.errors)}`);
});
