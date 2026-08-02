// Public entry for the format package (layer 1, beside parse). Code OUTSIDE
// src/format/ imports only this file; internals live in ./emit and are private.
// Curated re-exports only, never a star-export barrel. See docs/agent-analyzability.md.
export { emitModule } from "./emit";
export type { EmitOptions } from "./emit";
