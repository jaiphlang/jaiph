// Curated entry for the serve slice. The `jaiph serve` command (in the
// commands composition root) wires these four modules together; grouping their
// public symbols here keeps that command's fan-out bounded. Explicit named
// re-exports only — no `export *` barrel (docs/agent-analyzability.md).
export { ServeHandler } from "./handler";
export type { RunRecord, RunStatus, ServeHandlerOptions } from "./handler";
export { createAuthenticator } from "./auth";
export type { AuthConfig, Authenticator } from "./auth";
export { loadPersistedRuns, persistRunRecord } from "./run-store";
export { createHttpServer, listen } from "./server";
