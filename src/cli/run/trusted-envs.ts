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
 *    keys cross the sandbox allowlist like `--env` pairs do. Under Docker the
 *    in-file declaration is *not* consent on its own — an untrusted/model-edited
 *    entry file could name arbitrary host secrets (`AWS_SECRET_ACCESS_KEY`,
 *    `GITHUB_TOKEN`) and pull them across the allowlist the sandbox exists to
 *    enforce (finding M-7). The operator opt-in `JAIPH_TRUSTED_ENVS` is the
 *    consent that lets the declaration be honoured; without it the entry file's
 *    `trusted_envs` is ignored under Docker (with a warning) and `resolved` stays
 *    empty. Authoring the entry file is a trust boundary equal to `--env`.
 */
export interface TrustedEnvPlan {
  errors: string[];
  warnings: string[];
  resolved: Record<string, string>;
}

export interface PlanTrustedEnvsOptions {
  /** True when Docker is the active sandbox for this run. */
  dockerEnabled: boolean;
  /** Operator opt-in (`JAIPH_TRUSTED_ENVS`) to honour the entry file's `trusted_envs`. */
  optIn: boolean;
}

/**
 * Operator opt-in (`JAIPH_TRUSTED_ENVS=1|true`) required before the entry
 * file's `trusted_envs` is honoured under Docker — authoring the entry file is
 * a trust boundary equal to `--env`, so the operator, not the file, consents to
 * which host secrets cross the sandbox allowlist (finding M-7).
 */
export function isTrustedEnvsOptIn(env: Record<string, string | undefined>): boolean {
  return env.JAIPH_TRUSTED_ENVS === "1" || env.JAIPH_TRUSTED_ENVS === "true";
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
  opts: PlanTrustedEnvsOptions = { dockerEnabled: false, optIn: false },
): TrustedEnvPlan {
  const plan: TrustedEnvPlan = { errors: [], warnings: [], resolved: {} };
  const entry = graph.modules.get(graph.entryFile)?.ast;
  if (!entry) return plan;

  const entryKeys = collectEntryTrustedEnvKeys(entry);

  // Under Docker the entry file's declaration alone is not consent: it would
  // pull the named host secrets across the sandbox allowlist. Honour it only
  // when the operator opts in (`JAIPH_TRUSTED_ENVS`); otherwise ignore it (leave
  // `resolved` empty so nothing is forwarded) and warn so the operator can opt
  // in deliberately. Host modes have no allowlist to bypass — the runner
  // inherits the host env directly — so they honour the declaration as before.
  if (opts.dockerEnabled && !opts.optIn) {
    if (entryKeys.length > 0) {
      plan.warnings.push(
        `jaiph: warning: trusted_envs declared in entry file ${graph.entryFile} is ignored — set JAIPH_TRUSTED_ENVS=1 to forward the declared keys (${entryKeys.join(", ")}) into the Docker sandbox; authoring the entry file is a trust boundary equal to --env`,
      );
    }
  } else {
    for (const key of entryKeys) {
      const value = extraEnv[key] ?? hostEnv[key];
      if (value === undefined) {
        plan.errors.push(
          `E_ENV_MISSING trusted_envs ${key}: declared in ${graph.entryFile} but ${key} is not set on the host (export it or pass --env ${key}=VALUE)`,
        );
      } else {
        plan.resolved[key] = value;
      }
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
