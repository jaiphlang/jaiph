// Public entry for the runtime package (layer 3). Code OUTSIDE src/runtime/
// imports ONLY this file; everything under src/runtime/** stays private (the
// deep-module contract in docs/agent-analyzability.md, enforced by the
// `no-deep-imports-into-runtime` rule in .dependency-cruiser.cjs). This surface
// is curated for the CLI and other outsiders — graph construction, launch and
// runner entry points, the Docker sandbox, emit/redact/portability helpers,
// embedded assets, and run-tree param display. Add a named re-export here
// rather than letting a caller reach into a kernel internal.

// Graph construction (runtime input the CLI builds and hands to the runner).
export { buildRuntimeGraph } from "./kernel/graph";
export type { RuntimeGraph } from "./kernel/graph";

// Launch / runner entry points.
export { runWorkflowRunner, WORKFLOW_RUNNER_ARG } from "./kernel/node-workflow-runner";
export { spawnJaiphWorkflowProcess } from "./kernel/workflow-launch";
export { runTestFile } from "./kernel/node-test-runner";

// Docker sandbox driver.
export {
  CONTAINER_RUN_DIR,
  DOCKER_SANDBOX_ENV,
  RUN_WORKFLOW_ENV,
  spawnDockerProcess,
  stopDockerContainer,
  stopDockerRunOnSignal,
  withDockerExitGuard,
  resolveDockerHostRunsRoot,
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectSandboxMode,
  selectMcpSandboxMode,
  isRunningInContainer,
  isEnvAllowed,
} from "./docker";
export type { DockerRunConfig, SandboxMode, AgentBackend } from "./docker";
export {
  confirmInplaceRun,
  confirmUnsafeRun,
  UNSAFE_RUN_LOGWARN_MESSAGE,
} from "./docker-inplace";

// Emit / audit-chain helpers the CLI reads after a run.
export {
  CHAIN_KEY_ENV,
  generateChainKey,
  writeChainKey,
  verifyRunJournal,
} from "./kernel/emit";
export { redactCredentials } from "./kernel/redact";

// Terminal portability helpers.
export { canUseAnsi, killProcessTree, resolveShell } from "./kernel/portability";

// Assets embedded into the runtime bundle (skill doc, Swagger UI).
export {
  JAIPH_SKILL_MD_BASE64,
  SWAGGER_UI_BUNDLE_JS_BASE64,
  SWAGGER_UI_CSS_BASE64,
  decodeEmbeddedAsset,
} from "./embedded-assets";

// Run-tree param display (the kernel emits these pairs; the CLI formats them).
export { buildStepDisplayParamPairs } from "./kernel/format-params";
