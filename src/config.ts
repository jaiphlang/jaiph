import type { WorkflowMetadata } from "./types";

export type JaiphConfig = {
  agent?: {
    defaultModel?: string;
    command?: string;
  };
  run?: {
    debug?: boolean;
    logsDir?: string;
  };
};

function mergeConfig(base: JaiphConfig, override: JaiphConfig): JaiphConfig {
  const out: JaiphConfig = {
    agent: { ...(base.agent ?? {}) },
    run: { ...(base.run ?? {}) },
  };
  if (override.agent) {
    out.agent = { ...(out.agent ?? {}), ...override.agent };
  }
  if (override.run) {
    out.run = { ...(out.run ?? {}), ...override.run };
  }
  if (out.agent && Object.keys(out.agent).length === 0) {
    delete out.agent;
  }
  if (out.run && Object.keys(out.run).length === 0) {
    delete out.run;
  }
  return out;
}

/** Convert in-file workflow metadata to JaiphConfig shape for merging. */
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

/** Merge config with in-file metadata; metadata wins. Use for runtime env resolution. */
export function mergeConfigWithMetadata(config: JaiphConfig, metadata: WorkflowMetadata | undefined): JaiphConfig {
  return mergeConfig(config, metadataToConfig(metadata));
}
