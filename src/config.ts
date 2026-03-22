import type { WorkflowMetadata } from "./types";

export type JaiphConfig = {
  agent?: {
    defaultModel?: string;
    command?: string;
    backend?: "cursor" | "claude";
    trustedWorkspace?: string;
    cursorFlags?: string;
    claudeFlags?: string;
  };
  run?: {
    debug?: boolean;
    logsDir?: string;
    inboxParallel?: boolean;
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
