import { mkdirSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { loadModuleGraph, writeModuleGraph, type ModuleGraph } from "../../transpile/module-graph";
import { collectDiagnostics } from "../../transpile/validate";
import { buildScriptsFromGraph } from "../../transpiler";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectMcpSandboxMode,
  type DockerRunConfig,
  type SandboxMode,
} from "../../runtime/docker";
import { resolveRuntimeEnv } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import { deriveTools, type McpToolSpec } from "../mcp/tools";
import type { WorkflowCallEnvironment } from "../exec/call";

/** How often `watchFile` polls module sources for hot reload (ms). */
export const WATCH_INTERVAL_MS = 750;

/** Everything one generation of a workflow server needs to serve + call. */
export interface GenerationState {
  graph: ModuleGraph;
  tools: McpToolSpec[];
  callEnv: WorkflowCallEnvironment;
}

/**
 * Load (or reload) everything one generation of a workflow server needs:
 * module graph, compile-time validation, tool derivation, emitted scripts, and
 * the serialized graph the spawned runners consume. Shared by `jaiph mcp` and
 * `jaiph serve`. Throws on parse/loader errors; returns diagnostics without
 * throwing on validation errors.
 */
export function loadGeneration(
  inputAbs: string,
  workspaceRoot: string,
  tempRoot: string,
  generation: number,
  extraEnv: Record<string, string>,
  log: (line: string) => void,
  label: string,
): { state?: GenerationState; failures: string[] } {
  const graph = loadModuleGraph(inputAbs, workspaceRoot);
  const diag = collectDiagnostics(graph);
  if (diag.errors.length > 0) {
    return {
      failures: diag.sorted().map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`),
    };
  }

  const mod = graph.modules.get(inputAbs)!.ast;
  const { tools, warnings } = deriveTools(mod, inputAbs);
  for (const w of warnings) log(`${label}: ${w}`);

  const outDir = join(tempRoot, `gen-${generation}`);
  mkdirSync(outDir, { recursive: true });
  const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
  const graphFile = join(outDir, ".jaiph-module-graph.json");
  writeModuleGraph(graphFile, graph);

  const resolvedModuleMetadata = resolveModuleMetadata(mod, process.env);
  const effectiveConfig = metadataToConfig(resolvedModuleMetadata);

  return {
    state: {
      graph,
      tools,
      callEnv: { inputAbs, workspaceRoot, mod, effectiveConfig, scriptsDir, graphFile, outDir, extraEnv },
    },
    failures: [],
  };
}

/**
 * Resolve the shared startup sandbox posture for a workflow server (`jaiph mcp`
 * and `jaiph serve`): the env-driven Docker selection (`jaiph run` semantics),
 * a one-time image preparation when Docker is on, and the credential pre-flight
 * (demoted to warnings — the server may outlive a credential fix). Throws when
 * Docker is enabled but unavailable / the image can't be prepared; the caller
 * turns that into an exit-1. Returns the resolved config + sandbox mode so the
 * caller can print its own startup notice.
 */
export function resolveStartupPosture(
  state: GenerationState,
  inputAbs: string,
  workspaceRoot: string,
  log: (line: string) => void,
): { dockerConfig: DockerRunConfig; sandboxMode: SandboxMode } {
  const mod = state.graph.modules.get(inputAbs)!.ast;
  const startupEnv = resolveRuntimeEnv(state.callEnv.effectiveConfig, workspaceRoot, inputAbs);
  const dockerConfig = resolveDockerConfig(resolveModuleMetadata(mod, process.env)?.runtime, startupEnv);
  if (dockerConfig.enabled) {
    // Prepare the image once here rather than per call (a cold pull is slow).
    checkDockerAvailable();
    prepareImage(dockerConfig);
  }
  const sandboxMode = selectMcpSandboxMode(startupEnv);
  // Credential pre-flight once at startup (warnings only: the server may outlive
  // a credential fix, and per-call failures still surface).
  const credPreflight = preflightAgentCredentials({
    mod,
    inputAbs,
    runtimeEnv: startupEnv,
    dockerEnabled: dockerConfig.enabled,
  });
  for (const w of [...credPreflight.warnings, ...credPreflight.errors]) log(w);
  return { dockerConfig, sandboxMode };
}

/**
 * A `watchFile`-based source watcher shared by `jaiph mcp` and `jaiph serve`.
 * `rewatch(files)` swaps the watched set (unwatch old, watch new) so each hot
 * reload re-derives the file list from the current module graph; `stop()`
 * unwatches everything on shutdown. The `onChange` callback is the single
 * listener registered against every file, so unwatch matches watch exactly.
 */
export function createSourceWatcher(
  intervalMs: number,
  onChange: () => void,
): { rewatch: (files: string[]) => void; stop: () => void } {
  let watched: string[] = [];
  return {
    rewatch(files: string[]): void {
      for (const f of watched) unwatchFile(f, onChange);
      watched = [...files];
      for (const f of watched) watchFile(f, { interval: intervalMs }, onChange);
    },
    stop(): void {
      for (const f of watched) unwatchFile(f, onChange);
      watched = [];
    },
  };
}
