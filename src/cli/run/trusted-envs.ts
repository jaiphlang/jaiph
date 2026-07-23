import type { ModuleGraph } from "../../transpile/module-graph";
import type { jaiphModule } from "../../types";

/**
 * Host-side plan for the entry file's `trusted_envs` declarations, computed
 * before any process is spawned (same fail-fast stage as the credential
 * pre-flight and `resolveEnvPairs`).
 *
 *  - `errors`: a declared key with no value from `--env` or the host env is a
 *    hard `E_ENV_MISSING` failure — the declaration is the file's stated
 *    requirement, so running without it would only fail later and deeper.
 *  - `warnings`: `trusted_envs` in an imported (non-entry) module is ignored
 *    by the runtime; surface that so the author isn't left guessing.
 *  - `resolved`: `KEY -> value` for the entry file's declared keys, with an
 *    explicit `--env KEY=VALUE` overriding the host value. Host modes need no
 *    forwarding (the runner inherits the host env and snapshots it); Docker
 *    threads this map through `DockerSpawnOptions.extraEnv` so the declared
 *    keys cross the sandbox allowlist like `--env` pairs do — the in-file
 *    declaration is the per-key consent.
 */
export interface TrustedEnvPlan {
  errors: string[];
  warnings: string[];
  resolved: Record<string, string>;
}

/** Entry-file declared keys in declaration order: module-level, then per-workflow. */
function collectEntryTrustedEnvKeys(entry: jaiphModule): string[] {
  const keys: string[] = [];
  for (const key of entry.metadata?.trustedEnvs ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }
  for (const wf of entry.workflows) {
    for (const key of wf.metadata?.trustedEnvs ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function moduleDeclaresTrustedEnvs(mod: jaiphModule): boolean {
  if (mod.metadata?.trustedEnvs?.length) return true;
  return mod.workflows.some((wf) => Boolean(wf.metadata?.trustedEnvs?.length));
}

export function planTrustedEnvs(
  graph: ModuleGraph,
  extraEnv: Record<string, string>,
  hostEnv: Record<string, string | undefined>,
): TrustedEnvPlan {
  const plan: TrustedEnvPlan = { errors: [], warnings: [], resolved: {} };
  const entry = graph.modules.get(graph.entryFile)?.ast;
  if (!entry) return plan;

  for (const key of collectEntryTrustedEnvKeys(entry)) {
    const value = extraEnv[key] ?? hostEnv[key];
    if (value === undefined) {
      plan.errors.push(
        `E_ENV_MISSING trusted_envs ${key}: declared in ${graph.entryFile} but ${key} is not set on the host (export it or pass --env ${key}=VALUE)`,
      );
    } else {
      plan.resolved[key] = value;
    }
  }

  for (const [filePath, node] of graph.modules) {
    if (filePath === graph.entryFile) continue;
    if (moduleDeclaresTrustedEnvs(node.ast)) {
      plan.warnings.push(
        `jaiph: warning: trusted_envs declared in imported module ${filePath} is ignored — only the entry file's trusted_envs is honored`,
      );
    }
  }

  return plan;
}
