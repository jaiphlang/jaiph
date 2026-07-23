// `trusted_envs` runtime policy (see docs/configuration.md#trusted_envs).
//
// Declared keys resolve against the pristine env snapshot captured once at
// runtime construction — never against a calling workflow's scope env. Only
// the entry file's declarations are honored: an imported module must not be
// able to pull arbitrary host secrets into its own trusted steps. Every key
// declared anywhere in the graph is scrubbed from workflow scope envs, so a
// workflow (or imported module) that did not declare a key cannot see it
// ambiently; the values reappear only in the declaring workflow's `run`-step
// script spawns (`executeRunRef`).

import type { WorkflowMetadata } from "../../types";
import type { RuntimeGraph } from "./graph";

/**
 * Every `trusted_envs` key declared anywhere in the graph — module-level and
 * workflow-level, entry and imported modules alike. This is the scrub set:
 * declaring a key anywhere makes it non-ambient everywhere, so imported-module
 * declarations remove access instead of granting it.
 */
export function collectDeclaredTrustedEnvKeys(graph: RuntimeGraph): Set<string> {
  const keys = new Set<string>();
  for (const node of graph.modules.values()) {
    for (const key of node.ast.metadata?.trustedEnvs ?? []) keys.add(key);
    for (const wf of node.ast.workflows) {
      for (const key of wf.metadata?.trustedEnvs ?? []) keys.add(key);
    }
  }
  return keys;
}

/**
 * Keys one workflow may receive: the module-level declaration (sugar for
 * every workflow in the file) plus the workflow's own. Caller is responsible
 * for the entry-file gate — pass metadata from the entry module only.
 */
export function trustedEnvKeysForWorkflow(
  moduleMeta: WorkflowMetadata | undefined,
  workflowMeta: WorkflowMetadata | undefined,
): string[] {
  const keys: string[] = [];
  for (const key of moduleMeta?.trustedEnvs ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }
  for (const key of workflowMeta?.trustedEnvs ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Pick the declared keys that have a value in the pristine snapshot. */
export function resolveTrustedEnv(
  snapshot: NodeJS.ProcessEnv,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = snapshot[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
