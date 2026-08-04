// Facade for the Docker sandbox driver. The implementation is split across four
// sibling files — each a single Docker concern kept under the analyzability line
// cap — and this module re-exports their curated surface so `./docker` stays the
// one import site for the runtime public entry, `docker-inplace`, and the Docker
// tests. Explicit named re-exports only; no `export *`.
//
//   docker-config.ts   config resolution + image-ref / digest helpers
//   docker-image.ts    availability probe, image pull, image verification
//   docker-sandbox.ts  sandbox-mode selection + workspace snapshot cloning
//   docker-run.ts      `docker run` args, spawn + timeout, lifecycle

export {
  isHostSafeInFileNetwork,
  resolveDefaultDockerImageTag,
  GHCR_IMAGE_REPO,
  _win32Notice,
  imageRepoName,
  normalizeImageDigest,
  resolveExpectedDigest,
  resolveDockerConfig,
} from "./docker-config";
export type { DockerRunConfig } from "./docker-config";

export {
  _dockerExec,
  _containerIndicator,
  isRunningInContainer,
  checkDockerAvailable,
  pullImageIfNeeded,
  verifyImageDigest,
  PROBE_USER,
  buildImageProbeArgs,
  IMAGE_PROBE_TIMEOUT_MS,
  IMAGE_PROBE_ATTEMPTS,
  isTransientDockerProbeError,
  verifyImageHasJaiph,
  prepareImage,
  resolveImage,
} from "./docker-image";

export {
  selectSandboxMode,
  selectMcpSandboxMode,
  _cpSpawn,
  _gitLsFiles,
  cloneWorkspaceForSandbox,
  allocateSandboxWorkspaceDir,
} from "./docker-sandbox";
export type { SandboxMode } from "./docker-sandbox";

export {
  _dockerSpawn,
  _uidDetect,
  validateMountHostPath,
  CONTAINER_WORKSPACE,
  CONTAINER_RUN_DIR,
  DOCKER_SANDBOX_ENV,
  resolveDockerHostRunsRoot,
  remapDockerEnv,
  buildDockerArgs,
  spawnDockerProcess,
  stopDockerContainer,
  stopDockerRunOnSignal,
  cleanupDocker,
  withDockerExitGuard,
} from "./docker-run";
export type { DockerSpawnOptions, DockerSpawnResult } from "./docker-run";

// The agent env allowlist lives in the kernel (`kernel/env-allowlist.ts`) so
// the prompt backend spawn applies the same fail-closed policy in every sandbox
// mode; re-exported here for the Docker boundary's existing consumers.
export {
  BACKEND_CREDENTIAL_KEYS,
  ENV_ALLOW_PREFIXES,
  ENV_ALLOW_EXCLUDE_PREFIX,
  ENV_ALLOW_EXCLUDE_PREFIXES,
  ENV_ALLOW_EXCLUDE_NAMES,
  RUN_WORKFLOW_ENV,
  isEnvAllowed,
  type AgentBackend,
} from "./kernel/env-allowlist";
