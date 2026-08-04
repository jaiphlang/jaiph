import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadModuleGraph,
  writeModuleGraph,
  buildScriptsFromGraph,
  collectDiagnostics,
} from "../../transpiler";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import { loadMergedHooks, isProjectHooksTrusted } from "../run/hooks";
import { deriveTools } from "./mcp-tools";
import type { SandboxFlags } from "../run/env";
import type { GenerationState } from "./generation-state";

// The generation "shape" lives in its own leaf so the posture module can read
// it without importing back into this file; re-export it here so callers keep a
// single import site for the generation surface.
export type { GenerationState } from "./generation-state";
// Sandbox-posture resolution is a sibling concern (Docker selection, consent
// gate, credential pre-flight); re-exported so `jaiph mcp` / `jaiph serve` reach
// the whole generation surface through this one module.
export {
  resolveStartupPosture,
  logStartupPosture,
  formatUnsafeServerBanner,
  type StartupPosture,
} from "./startup-posture";

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
  sandboxFlags: SandboxFlags = {},
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

  // Hooks reload with the generation, so a hooks.json edit is picked up on the
  // next source change like every other per-generation input. Project-local
  // hooks stay gated behind the per-workspace trust opt-in (finding M-10); the
  // server reads it from the host env, the same as `jaiph run`.
  const hooks = loadMergedHooks(workspaceRoot, isProjectHooksTrusted(process.env));

  return {
    state: {
      graph,
      tools,
      callEnv: { inputAbs, workspaceRoot, mod, effectiveConfig, scriptsDir, graphFile, outDir, extraEnv, sandboxFlags, hooks },
    },
    failures: [],
  };
}

/** One live generation with the refcount that keeps its scripts dir alive. */
interface LiveGeneration {
  state: GenerationState;
  refs: number;
  superseded: boolean;
}

/** A lease on one generation, held by one in-flight call. */
export interface GenerationLease {
  /** The generation live when the call started; stable for the call's lifetime. */
  state: GenerationState;
  /** Settle the lease (idempotent). The last release of a superseded generation deletes its out dir. */
  release: () => void;
}

export interface GenerationTracker {
  /** The generation new calls should bind to. */
  current: () => GenerationState;
  /** Lease the current generation for one call; release when the call settles. */
  acquire: () => GenerationLease;
  /** Install a new generation; the previous one is deleted once its last lease settles. */
  swap: (next: GenerationState) => void;
}

/**
 * Refcounted generation lifecycle shared by `jaiph mcp` and `jaiph serve`. A
 * hot reload must not delete the superseded generation's out dir (emitted
 * scripts + serialized graph) while a call started under it is still running —
 * the runner spawns each script step from that dir for the whole run. Calls
 * lease the generation live at call start; a superseded generation's dir is
 * removed only when its last lease is released (immediately on swap when idle).
 */
export function createGenerationTracker(initial: GenerationState): GenerationTracker {
  let current: LiveGeneration = { state: initial, refs: 0, superseded: false };
  const maybeDelete = (gen: LiveGeneration): void => {
    if (gen.superseded && gen.refs === 0) {
      rmSync(gen.state.callEnv.outDir, { recursive: true, force: true });
    }
  };
  return {
    current: () => current.state,
    acquire(): GenerationLease {
      const gen = current;
      gen.refs += 1;
      let released = false;
      return {
        state: gen.state,
        release(): void {
          if (released) return;
          released = true;
          gen.refs -= 1;
          maybeDelete(gen);
        },
      };
    },
    swap(next: GenerationState): void {
      const prev = current;
      current = { state: next, refs: 0, superseded: false };
      prev.superseded = true;
      maybeDelete(prev);
    },
  };
}
