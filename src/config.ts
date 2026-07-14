import type { EnvDeclDef, WorkflowMetadata } from "./types";
import { interpolate } from "./runtime/kernel/runtime-arg-parser";
import { configValueHasInterpolation } from "./parse/metadata";

export type JaiphConfig = {
  agent?: {
    defaultModel?: string;
    command?: string;
    backend?: "cursor" | "claude" | "codex";
    trustedWorkspace?: string;
    cursorFlags?: string;
    claudeFlags?: string;
  };
  run?: {
    debug?: boolean;
    logsDir?: string;
  };
};

/** Convert in-file workflow metadata to JaiphConfig shape for runtime env resolution. */
export function metadataToConfig(metadata: WorkflowMetadata | undefined): JaiphConfig {
  if (!metadata) {
    return {};
  }
  const cfg: JaiphConfig = {};
  if (metadata.agent) {
    cfg.agent = { ...metadata.agent };
  }
  if (metadata.run) {
    cfg.run = { ...metadata.run };
  }
  return cfg;
}

/** Resolve module-level `config { }` string interpolation from module `const` values and env. */
export function resolveModuleMetadata(
  mod: { metadata?: WorkflowMetadata; envDecls?: EnvDeclDef[] },
  env?: NodeJS.ProcessEnv,
): WorkflowMetadata | undefined {
  if (!mod.metadata) return undefined;
  const vars = buildConstVars(mod.envDecls, undefined, env);
  return interpolateWorkflowMetadata(mod.metadata, vars, env);
}

function interpolateStringField(
  value: string,
  vars: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): string {
  return configValueHasInterpolation(value) ? interpolate(value, vars, env) : value;
}

/** Build a variable map from module-level `const` declarations (with chained interpolation). */
export function buildConstVars(
  envDecls: EnvDeclDef[] | undefined,
  parent?: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): Map<string, string> {
  const vars = new Map<string, string>(parent ? Array.from(parent.entries()) : []);
  if (!envDecls) return vars;
  for (const decl of envDecls) {
    vars.set(decl.name, interpolate(decl.value, vars, env));
  }
  return vars;
}

/** Resolve `${…}` references in workflow/module metadata string fields. */
export function interpolateWorkflowMetadata(
  metadata: WorkflowMetadata,
  vars: Map<string, string>,
  env?: NodeJS.ProcessEnv,
): WorkflowMetadata {
  const out: WorkflowMetadata = {};
  if (metadata.agent) {
    out.agent = {};
    if (metadata.agent.defaultModel !== undefined) {
      out.agent.defaultModel = interpolateStringField(metadata.agent.defaultModel, vars, env);
    }
    if (metadata.agent.command !== undefined) {
      out.agent.command = interpolateStringField(metadata.agent.command, vars, env);
    }
    if (metadata.agent.backend !== undefined) {
      out.agent.backend = interpolateStringField(metadata.agent.backend, vars, env) as
        | "cursor"
        | "claude"
        | "codex";
    }
    if (metadata.agent.trustedWorkspace !== undefined) {
      out.agent.trustedWorkspace = interpolateStringField(metadata.agent.trustedWorkspace, vars, env);
    }
    if (metadata.agent.cursorFlags !== undefined) {
      out.agent.cursorFlags = interpolateStringField(metadata.agent.cursorFlags, vars, env);
    }
    if (metadata.agent.claudeFlags !== undefined) {
      out.agent.claudeFlags = interpolateStringField(metadata.agent.claudeFlags, vars, env);
    }
  }
  if (metadata.run) {
    out.run = { ...metadata.run };
    if (metadata.run.logsDir !== undefined) {
      out.run.logsDir = interpolateStringField(metadata.run.logsDir, vars, env);
    }
  }
  if (metadata.runtime) {
    out.runtime = { ...metadata.runtime };
    if (metadata.runtime.dockerImage !== undefined) {
      out.runtime.dockerImage = interpolateStringField(metadata.runtime.dockerImage, vars, env);
    }
    if (metadata.runtime.dockerNetwork !== undefined) {
      out.runtime.dockerNetwork = interpolateStringField(metadata.runtime.dockerNetwork, vars, env);
    }
  }
  if (metadata.module) {
    out.module = {};
    if (metadata.module.name !== undefined) {
      out.module.name = interpolateStringField(metadata.module.name, vars, env);
    }
    if (metadata.module.version !== undefined) {
      out.module.version = interpolateStringField(metadata.module.version, vars, env);
    }
    if (metadata.module.description !== undefined) {
      out.module.description = interpolateStringField(metadata.module.description, vars, env);
    }
  }
  return out;
}
