// Curated internal facade for the runtime kernel. The kernel is private to the
// runtime slice (docs/agent-analyzability.md), but its CLI-facing symbols are
// spread across many sibling files; grouping the ones the public entry re-exports
// here keeps `src/runtime/index.ts` fan-out under the cap. Explicit named
// re-exports only — no `export *`. Add a symbol here only when the runtime public
// entry needs to surface it to the CLI.

// Graph construction (runtime input the CLI builds and hands to the runner).
export { buildRuntimeGraph } from "./graph";
export type { RuntimeGraph } from "./graph";

// Launch / runner entry points.
export { runWorkflowRunner, WORKFLOW_RUNNER_ARG } from "./node-workflow-runner";
export { spawnJaiphWorkflowProcess } from "./workflow-launch";
export { runTestFile } from "./node-test-runner";

// Emit / audit-chain helpers the CLI reads after a run.
export {
  CHAIN_KEY_ENV,
  generateChainKey,
  writeChainKey,
  verifyRunJournal,
} from "./emit";
export { redactCredentials } from "./redact";

// Terminal portability helpers.
export { canUseAnsi, killProcessTree, resolveShell } from "./portability";

// Run-tree param display (the kernel emits these pairs; the CLI formats them).
export { buildStepDisplayParamPairs } from "./format-params";
