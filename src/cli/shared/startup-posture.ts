import { join } from "node:path";
import { resolveModuleMetadata } from "../../config";
import { resolveRuntimeEnv } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import type { GenerationState } from "./generation-state";

/** Startup posture of a workflow server, resolved once and applied to every call. */
export interface StartupPosture {
  hostRunsRoot: string;
}

/**
 * Resolve the shared startup posture for a workflow server (`jaiph mcp` and
 * `jaiph serve`): runtime env, credential pre-flight (demoted to warnings —
 * the server may outlive a credential fix), and the host-visible runs root.
 */
export function resolveStartupPosture(
  state: GenerationState,
  inputAbs: string,
  workspaceRoot: string,
  log: (line: string) => void,
): StartupPosture {
  const mod = state.graph.modules.get(inputAbs)!.ast;
  const startupEnv = resolveRuntimeEnv(state.callEnv.effectiveConfig, workspaceRoot, inputAbs);
  const credPreflight = preflightAgentCredentials({
    mod,
    inputAbs,
    runtimeEnv: startupEnv,
  });
  for (const w of [...credPreflight.warnings, ...credPreflight.errors]) log(w);
  return { hostRunsRoot: resolveHostRunsRoot(workspaceRoot, startupEnv) };
}

/**
 * Print the execution notice once at server startup — the single notice both
 * `jaiph serve` and `jaiph mcp` emit. `noun` names what the server executes
 * ("runs" for HTTP, "tool calls" for MCP).
 */
export function logStartupPosture(
  label: string,
  noun: string,
  _posture: StartupPosture,
  _workspaceRoot: string,
  log: (line: string) => void,
): void {
  log(`${label}: ${noun} execute on the host.`);
}

/** Host runs root: absolute `JAIPH_RUNS_DIR` as-is, relative under the workspace, else `.jaiph/runs`. */
function resolveHostRunsRoot(workspaceRoot: string, env: Record<string, string | undefined>): string {
  const configured = env.JAIPH_RUNS_DIR;
  if (configured && configured.length > 0) {
    return configured.startsWith("/") ? configured : join(workspaceRoot, configured);
  }
  return join(workspaceRoot, ".jaiph", "runs");
}
