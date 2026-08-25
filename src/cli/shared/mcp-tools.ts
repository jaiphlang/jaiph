import { basename } from "node:path";
import type { jaiphModule, Def } from "../../types";

/** JSON Schema fragment for one MCP tool input (all Jaiph params are strings). */
export interface McpInputSchema {
  type: "object";
  properties: Record<string, { type: "string" }>;
  required?: string[];
  additionalProperties: false;
}

/** One exposed def: MCP surface plus the def symbol to invoke. */
export interface McpToolSpec {
  /** MCP tool name (`^[a-zA-Z0-9_-]{1,128}$`). */
  name: string;
  /** Def symbol in the entry module (`main` may differ from `name`). */
  def: string;
  description: string;
  /** Declared parameter names, in call order. */
  params: string[];
  inputSchema: McpInputSchema;
}

export interface DeriveToolsResult {
  tools: McpToolSpec[];
  /** Human-readable notes about skipped defs (stderr, never stdout). */
  warnings: string[];
}

/**
 * Sanitize a file basename into an MCP tool name: strip the `.jh` suffix and
 * replace anything outside `[A-Za-z0-9_-]` with `_`.
 */
export function toolNameFromFile(inputAbs: string): string {
  const base = basename(inputAbs).replace(/\.jh$/, "");
  const slug = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return slug.length > 0 ? slug.slice(0, 128) : "def";
}

/**
 * Build the tool description from the workflow's leading comments.
 * Comment lines are stored raw (including `#`); shebang lines are dropped.
 */
function describeDef(wf: Def, inputAbs: string): string {
  const lines = wf.comments
    .filter((c) => !c.startsWith("#!"))
    .map((c) => c.replace(/^#\s?/, "").trimEnd())
    .filter((c) => c.length > 0);
  if (lines.length > 0) return lines.join("\n");
  return `Run the "${wf.name}" def from ${basename(inputAbs)}.`;
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
 * 1. Candidates are exported defs only. Zero exports → no tools.
 * 2. Skip `main` unless it is the only candidate; then expose it under the
 *    file basename (`deploy.jh` → `deploy`). `main` stays the `jaiph run`
 *    entrypoint, not a public tool next to other exports.
 */
export function deriveTools(mod: jaiphModule, inputAbs: string): DeriveToolsResult {
  const warnings: string[] = [];
  const candidates = mod.defs.filter((w) => mod.exports.includes(w.name));
  if (candidates.length === 0) {
    warnings.push("no exported defs; nothing exposed as an MCP tool");
  }

  const tools: McpToolSpec[] = [];
  const taken = new Set<string>();
  const mainWf = candidates.find((w) => w.name === "main");
  const named = candidates.filter((w) => w.name !== "main");

  for (const wf of named) {
    tools.push({
      name: wf.name,
      def: wf.name,
      description: describeDef(wf, inputAbs),
      params: [...wf.params],
      inputSchema: schemaForParams(wf.params),
    });
    taken.add(wf.name);
  }

  if (mainWf) {
    if (named.length > 0) {
      warnings.push(
        'def "main" is not exposed as an MCP tool (other exported defs exist; main stays the `jaiph run` entrypoint)',
      );
    } else {
      const slug = toolNameFromFile(inputAbs);
      if (taken.has(slug)) {
        warnings.push(`def "main" skipped: tool name "${slug}" already taken`);
      } else {
        tools.push({
          name: slug,
          def: "main",
          description: describeDef(mainWf, inputAbs),
          params: [...mainWf.params],
          inputSchema: schemaForParams(mainWf.params),
        });
      }
    }
  }

  return { tools, warnings };
}
