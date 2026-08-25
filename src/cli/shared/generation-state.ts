import type { ModuleGraph } from "../../transpiler";
import type { McpToolSpec } from "./mcp-tools";
import type { DefCallEnvironment } from "./workflow-call";

/**
 * Everything one generation of a workflow server needs to serve + call.
 *
 * Extracted into its own leaf so both `generation.ts` (which builds it) and
 * `startup-posture.ts` (which reads it) can reference the shape without an
 * import cycle — `generation.ts` re-exports the posture helpers, so the posture
 * module must not import back into `generation.ts`.
 */
export interface GenerationState {
  graph: ModuleGraph;
  tools: McpToolSpec[];
  callEnv: DefCallEnvironment;
}
