import { basename } from "node:path";
import type { jaiphModule, WorkflowDef } from "../../types";

/** JSON Schema fragment for one MCP tool input (all Jaiph params are strings). */
export interface McpInputSchema {
  type: "object";
  properties: Record<string, { type: "string" }>;
  required?: string[];
  additionalProperties: false;
}

/** One exposed workflow: MCP surface plus the workflow symbol to invoke. */
export interface McpToolSpec {
  /** MCP tool name (`^[a-zA-Z0-9_-]{1,128}$`). */
  name: string;
  /** Workflow symbol in the entry module (`default` may differ from `name`). */
  workflow: string;
  description: string;
  /** Declared parameter names, in call order. */
  params: string[];
  inputSchema: McpInputSchema;
}

export interface DeriveToolsResult {
  tools: McpToolSpec[];
  /** Human-readable notes about skipped workflows (stderr, never stdout). */
  warnings: string[];
}

/**
 * Sanitize a file basename into an MCP tool name: strip the `.jh` suffix and
 * replace anything outside `[A-Za-z0-9_-]` with `_`.
 */
export function toolNameFromFile(inputAbs: string): string {
  const base = basename(inputAbs).replace(/\.jh$/, "");
  const slug = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return slug.length > 0 ? slug.slice(0, 128) : "workflow";
}

/**
 * Build the tool description from the workflow's leading comments.
 * Comment lines are stored raw (including `#`); shebang lines are dropped.
 */
function describeWorkflow(wf: WorkflowDef, inputAbs: string): string {
  const lines = wf.comments
    .filter((c) => !c.startsWith("#!"))
    .map((c) => c.replace(/^#\s?/, "").trimEnd())
    .filter((c) => c.length > 0);
  if (lines.length > 0) return lines.join("\n");
  return `Run the "${wf.name}" workflow from ${basename(inputAbs)}.`;
}

function schemaForParams(params: string[]): McpInputSchema {
  const properties: Record<string, { type: "string" }> = {};
  for (const p of params) properties[p] = { type: "string" };
  const schema: McpInputSchema = { type: "object", properties, additionalProperties: false };
  if (params.length > 0) schema.required = [...params];
  return schema;
}

/**
 * Derive the MCP tool list from the entry module.
 *
 * Exposure rules (documented in docs/mcp.md):
 * 1. If the module declares `export workflow …`, exactly those are exposed.
 * 2. Otherwise every top-level workflow is exposed, minus channel route
 *    targets (the three-param inbox handlers wired via `channel … -> wf`).
 * 3. `default` is exposed only when it is the only candidate, under a tool
 *    name derived from the file's basename (`deploy.jh` → `deploy`); with
 *    other candidates present it is skipped (it is the `jaiph run`
 *    entrypoint, not a public tool).
 */
export function deriveTools(mod: jaiphModule, inputAbs: string): DeriveToolsResult {
  const warnings: string[] = [];
  const routeTargets = new Set<string>();
  for (const ch of mod.channels) {
    for (const route of ch.routes ?? []) routeTargets.add(route.value);
  }

  const exportedWorkflows = mod.workflows.filter((w) => mod.exports.includes(w.name));
  let candidates: WorkflowDef[];
  if (exportedWorkflows.length > 0) {
    candidates = exportedWorkflows;
  } else {
    candidates = mod.workflows.filter((w) => {
      if (routeTargets.has(w.name)) {
        warnings.push(`workflow "${w.name}" is a channel route target; not exposed as an MCP tool`);
        return false;
      }
      return true;
    });
  }

  const tools: McpToolSpec[] = [];
  const taken = new Set<string>();
  const defaultWf = candidates.find((w) => w.name === "default");
  const named = candidates.filter((w) => w.name !== "default");

  for (const wf of named) {
    tools.push({
      name: wf.name,
      workflow: wf.name,
      description: describeWorkflow(wf, inputAbs),
      params: [...wf.params],
      inputSchema: schemaForParams(wf.params),
    });
    taken.add(wf.name);
  }

  if (defaultWf) {
    if (named.length > 0) {
      warnings.push(
        'workflow "default" is not exposed as an MCP tool (other workflows exist; default stays the `jaiph run` entrypoint)',
      );
    } else {
      const slug = toolNameFromFile(inputAbs);
      if (taken.has(slug)) {
        warnings.push(`workflow "default" skipped: tool name "${slug}" already taken`);
      } else {
        tools.push({
          name: slug,
          workflow: "default",
          description: describeWorkflow(defaultWf, inputAbs),
          params: [...defaultWf.params],
          inputSchema: schemaForParams(defaultWf.params),
        });
      }
    }
  }

  return { tools, warnings };
}
