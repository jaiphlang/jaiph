// Public entry for the runtime package (layer 3). Code OUTSIDE src/runtime/
// imports ONLY this file; everything under src/runtime/** stays private (the
// deep-module contract in docs/agent-analyzability.md, enforced by the
// `no-deep-imports-into-runtime` rule in .dependency-cruiser.cjs). This surface
// is curated for the CLI and other outsiders — graph construction, launch and
// runner entry points, the Docker sandbox, emit/redact/portability helpers,
// embedded assets, and run-tree param display. Add a named re-export here
// rather than letting a caller reach into a kernel internal. The kernel's
// CLI-facing symbols are grouped behind `./kernel` so this entry stays low
// fan-out; Docker and embedded assets live outside the kernel and re-export here.
export {
  buildRuntimeGraph,
  runWorkflowRunner,
  WORKFLOW_RUNNER_ARG,
  spawnJaiphWorkflowProcess,
  runTestFile,
  CHAIN_KEY_ENV,
  generateChainKey,
  writeChainKey,
  verifyRunJournal,
  redactCredentials,
  canUseAnsi,
  killProcessTree,
  resolveShell,
  buildStepDisplayParamPairs,
} from "./kernel";
export type { RuntimeGraph } from "./kernel";

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

// Assets embedded into the runtime bundle (skill doc, Swagger UI).
export {
  JAIPH_SKILL_MD_BASE64,
  SWAGGER_UI_BUNDLE_JS_BASE64,
  SWAGGER_UI_CSS_BASE64,
  decodeEmbeddedAsset,
} from "./embedded-assets";
