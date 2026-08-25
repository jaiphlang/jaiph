// Second public entry for the runtime package (layer 3), scoped to TEST SEAMS.
// Cross-package *.test.ts files that need to reach a runtime internal import
// ONLY this file — never src/runtime/** directly. It is allowlisted alongside
// src/runtime/index.ts in the `no-deep-imports-into-runtime` rule
// (.dependency-cruiser.cjs). Keep this surface small and named: these symbols
// are private to the runtime and used by no production caller, so they stay off
// the CLI-facing production entry (src/runtime/index.ts). Add a seam here only
// when a cross-package test genuinely needs it.

// Audit-chain HMAC internals (tests reconstruct the expected chain).
export { CHAIN_GENESIS, chainHmac } from "./kernel/emit";

// Live-event emitter (tests capture emitted __JAIPH_EVENT__ frames).
export { RuntimeEventEmitter } from "./kernel/runtime-event-emitter";
