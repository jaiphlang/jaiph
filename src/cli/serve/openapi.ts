import type { McpToolSpec } from "../mcp/tools";

/** Identity of the server, embedded in `info`. */
export interface OpenApiServerInfo {
  /** `info.title` — e.g. `jaiph — tools.jh`. */
  title: string;
  /** `info.version` — the jaiph `VERSION`. */
  version: string;
}

/** A bearer-secured operation on the `/v1/*` surface. */
const BEARER_SECURITY = [{ bearer: [] as string[] }];

/** Standard `{error:{code,message}}` responses, keyed by HTTP status. */
function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function runResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
  };
}

/**
 * Build the OpenAPI 3.1.0 document for a running `jaiph serve` instance. Pure:
 * the same `(tools, serverInfo)` always yields the same document, so it can be
 * regenerated per request and picks up hot-reloaded tool sets for free.
 *
 * One concrete path per workflow (`/v1/workflows/<name>/runs`) carries that
 * workflow's own `operationId`, `#`-comment description, and the exact
 * MCP-derived input schema as its JSON request body — which is what makes
 * Swagger UI render a usable per-workflow form. The static run-resource paths,
 * the run/error component schemas, and the bearer security scheme complete the
 * document.
 */
export function buildOpenApi(tools: McpToolSpec[], serverInfo: OpenApiServerInfo): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const tool of tools) {
    const requestBody =
      tool.params.length > 0
        ? {
            required: true,
            content: { "application/json": { schema: tool.inputSchema } },
          }
        : { required: false, content: { "application/json": { schema: tool.inputSchema } } };
    paths[`/v1/workflows/${tool.name}/runs`] = {
      post: {
        operationId: `run_${tool.name}`,
        summary: `Run the ${tool.name} workflow`,
        description: tool.description,
        security: BEARER_SECURITY,
        parameters: [
          {
            name: "wait",
            in: "query",
            required: false,
            description: "Respond only when the run is terminal (200) instead of returning 202 immediately.",
            schema: { type: "boolean" },
          },
        ],
        requestBody,
        responses: {
          "200": runResponse("Run reached a terminal state (wait=true)."),
          "202": runResponse("Run accepted and started."),
          "400": errorResponse("Invalid arguments."),
          "401": errorResponse("Missing or invalid bearer token."),
          "413": errorResponse("Request body too large."),
          "415": errorResponse("Request body was not application/json."),
          "429": errorResponse("Too many concurrent runs."),
        },
      },
    };
  }

  paths["/healthz"] = {
    get: {
      operationId: "healthz",
      summary: "Liveness/readiness probe",
      responses: {
        "200": {
          description: "Server is up.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  version: { type: "string" },
                  tools: { type: "integer" },
                  in_flight: { type: "integer" },
                },
                required: ["status", "version", "tools", "in_flight"],
              },
            },
          },
        },
      },
    },
  };

  paths["/v1/workflows"] = {
    get: {
      operationId: "listWorkflows",
      summary: "List exposed workflows",
      security: BEARER_SECURITY,
      responses: {
        "200": {
          description: "The exposed workflows.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  workflows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        description: { type: "string" },
                        params: { type: "array", items: { type: "string" } },
                      },
                      required: ["name", "description", "params"],
                    },
                  },
                },
                required: ["workflows"],
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid bearer token."),
      },
    },
  };

  paths["/v1/runs"] = {
    get: {
      operationId: "listRuns",
      summary: "List runs started by this server (newest first, paginated)",
      security: BEARER_SECURITY,
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          description: "Page size (default 100, clamped to 1000). The response is never unbounded.",
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        },
        {
          name: "offset",
          in: "query",
          required: false,
          description: "Number of newest-first records to skip before the page.",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
      ],
      responses: {
        "200": {
          description: "One page of runs started by this server process, plus the total registry size.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runs: { type: "array", items: { $ref: "#/components/schemas/Run" } },
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                },
                required: ["runs", "total", "limit", "offset"],
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid bearer token."),
      },
    },
  };

  paths["/v1/runs/{id}"] = {
    get: {
      operationId: "getRun",
      summary: "Fetch one run",
      security: BEARER_SECURITY,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": runResponse("The run."),
        "401": errorResponse("Missing or invalid bearer token."),
        "404": errorResponse("Unknown run id."),
      },
    },
  };

  paths["/v1/runs/{id}/events"] = {
    get: {
      operationId: "getRunEvents",
      summary: "Stream a run's event journal",
      description:
        "The run's durable `run_summary.jsonl`. Default: `application/x-ndjson` snapshot. " +
        "With `Accept: text/event-stream`, Server-Sent Events replay the journal then follow it " +
        "live until the run is terminal (`event: end`). The journal is served verbatim — already " +
        "credential-redacted; raw step capture files are never exposed.",
      security: BEARER_SECURITY,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "The event journal (NDJSON snapshot or an SSE stream).",
          content: {
            "application/x-ndjson": { schema: { type: "string" } },
            "text/event-stream": { schema: { type: "string" } },
          },
        },
        "401": errorResponse("Missing or invalid bearer token."),
        "404": errorResponse("Unknown run id."),
      },
    },
  };

  paths["/v1/runs/{id}/artifacts"] = {
    get: {
      operationId: "listRunArtifacts",
      summary: "List a run's published artifacts",
      security: BEARER_SECURITY,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Files published under the run's artifacts directory (empty when none).",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  artifacts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        path: { type: "string" },
                        size: { type: "integer" },
                        mtime: { type: "string" },
                      },
                      required: ["path", "size", "mtime"],
                    },
                  },
                },
                required: ["artifacts"],
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid bearer token."),
        "404": errorResponse("Unknown run id."),
      },
    },
  };

  paths["/v1/runs/{id}/artifacts/{path}"] = {
    get: {
      operationId: "downloadRunArtifact",
      summary: "Download one published artifact",
      security: BEARER_SECURITY,
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "path", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The artifact bytes.",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        "401": errorResponse("Missing or invalid bearer token."),
        "404": errorResponse("Unknown run id or artifact (including any path traversal attempt)."),
      },
    },
  };

  paths["/v1/runs/{id}/cancel"] = {
    post: {
      operationId: "cancelRun",
      summary: "Cancel an in-flight run",
      security: BEARER_SECURITY,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "202": runResponse("Cancellation requested."),
        "401": errorResponse("Missing or invalid bearer token."),
        "404": errorResponse("Unknown run id."),
        "409": errorResponse("Run already terminal."),
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: { title: serverInfo.title, version: serverInfo.version },
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Run: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            workflow: { type: "string" },
            status: { type: "string", enum: ["running", "succeeded", "failed", "cancelled"] },
            started_at: { type: "string" },
            ended_at: { type: ["string", "null"] },
            exit_status: { type: ["integer", "null"] },
            signal: { type: ["string", "null"] },
            result_text: { type: ["string", "null"] },
            run_dir: { type: ["string", "null"] },
          },
          required: ["run_id", "workflow", "status", "started_at"],
        },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" } },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  };
}
