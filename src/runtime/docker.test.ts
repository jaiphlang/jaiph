import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMountHostPath,
  resolveDockerConfig,
  buildDockerArgs,
  remapDockerEnv,
  overlayMountPath,
  resolveDockerHostRunsRoot,
  writeOverlayScript,
  verifyImageHasJaiph,
  isEnvAllowed,
  GHCR_IMAGE_REPO,
  selectSandboxMode,
  cloneWorkspaceForSandbox,
  allocateSandboxWorkspaceDir,
  pullImageIfNeeded,
  _dockerExec,
  type DockerRunConfig,
  type DockerSpawnOptions,
} from "./docker";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Shared temp workspace for buildDockerArgs tests. */
const TEST_WS = mkdtempSync(join(tmpdir(), "jaiph-test-ws-"));
const TEST_SANDBOX = mkdtempSync(join(tmpdir(), "jaiph-test-sandbox-"));
const TEST_OVERLAY = writeOverlayScript();
const TEST_OVERLAY_DIR = dirname(TEST_OVERLAY);
test.after(() => {
  rmSync(TEST_WS, { recursive: true, force: true });
  rmSync(TEST_SANDBOX, { recursive: true, force: true });
  rmSync(TEST_OVERLAY_DIR, { recursive: true, force: true });
});

function defaultOpts(overrides?: Partial<DockerSpawnOptions>): DockerSpawnOptions {
  return {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      imageExplicit: false,
      network: "default",
      timeout: 300,
    },
    sourceAbs: join(TEST_WS, "main.jh"),
    workspaceRoot: TEST_WS,
    sandboxRunDir: TEST_SANDBOX,
    runArgs: [],
    env: {},
    isTTY: false,
    sandboxMode: "overlay",
    ...overrides,
  };
}

function copyOpts(sandboxWorkspaceDir: string, overrides?: Partial<DockerSpawnOptions>): DockerSpawnOptions {
  return defaultOpts({ sandboxMode: "copy", sandboxWorkspaceDir, ...overrides });
}

// ---------------------------------------------------------------------------
// resolveDockerConfig
// ---------------------------------------------------------------------------

test("resolveDockerConfig: defaults when no in-file and no env — Docker on", () => {
  const cfg = resolveDockerConfig(undefined, {});
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.image.startsWith(GHCR_IMAGE_REPO + ":"), `default image should be GHCR: ${cfg.image}`);
  assert.equal(cfg.network, "default");
  assert.equal(cfg.timeout, 300);
});

test("resolveDockerConfig: in-file image/timeout overrides defaults (dockerEnabled removed)", () => {
  const cfg = resolveDockerConfig(
    { dockerImage: "alpine:3.19", dockerTimeout: 60 },
    {},
  );
  assert.equal(cfg.enabled, true, "enabled defaults to true (no JAIPH_UNSAFE)");
  assert.equal(cfg.image, "alpine:3.19");
  assert.equal(cfg.timeout, 60);
});

test("resolveDockerConfig: env overrides in-file image", () => {
  const cfg = resolveDockerConfig(
    { dockerImage: "alpine:3.19" },
    { JAIPH_DOCKER_ENABLED: "false", JAIPH_DOCKER_IMAGE: "debian:12" },
  );
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.image, "debian:12");
});

test("resolveDockerConfig: CI=true does NOT disable Docker (CI runs the real sandbox path)", () => {
  const cfg = resolveDockerConfig(undefined, { CI: "true" });
  assert.equal(cfg.enabled, true);
});

test("resolveDockerConfig: CI=true does not disable Docker (env-only control)", () => {
  const cfg = resolveDockerConfig(undefined, { CI: "true" });
  assert.equal(cfg.enabled, true);
});

test("resolveDockerConfig: env JAIPH_DOCKER_ENABLED=false disables even when CI=true", () => {
  const cfg = resolveDockerConfig(undefined, { CI: "true", JAIPH_DOCKER_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("resolveDockerConfig: JAIPH_UNSAFE=true disables Docker by default", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_UNSAFE: "true" });
  assert.equal(cfg.enabled, false);
});

test("resolveDockerConfig: JAIPH_UNSAFE=true with env JAIPH_DOCKER_ENABLED=true enables Docker", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_UNSAFE: "true", JAIPH_DOCKER_ENABLED: "true" });
  assert.equal(cfg.enabled, true);
});

test("resolveDockerConfig: both CI and JAIPH_UNSAFE unset with explicit JAIPH_DOCKER_ENABLED=false disables", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_DOCKER_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("resolveDockerConfig: network env override", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_DOCKER_NETWORK: "none" });
  assert.equal(cfg.network, "none");
});

test("resolveDockerConfig: timeout env override", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_DOCKER_TIMEOUT: "120" });
  assert.equal(cfg.timeout, 120);
});

test("resolveDockerConfig: invalid timeout env falls back to default", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_DOCKER_TIMEOUT: "abc" });
  assert.equal(cfg.timeout, 300);
});

test("resolveDockerConfig: in-file dockerEnabled is ignored (field removed from RuntimeConfig)", () => {
  // After removal, even if someone constructs a RuntimeConfig with the old shape,
  // the enabled flag is derived from env only.
  const cfg = resolveDockerConfig({} as any, { JAIPH_UNSAFE: "true" });
  assert.equal(cfg.enabled, false, "JAIPH_UNSAFE disables Docker regardless of in-file");
});

test("checkDockerAvailable: E_DOCKER_NOT_FOUND message mentions JAIPH_UNSAFE", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(
    src.includes("JAIPH_UNSAFE=true to run on the host"),
    "E_DOCKER_NOT_FOUND must mention JAIPH_UNSAFE escape hatch",
  );
});

// ---------------------------------------------------------------------------
// buildDockerArgs
// ---------------------------------------------------------------------------

test("buildDockerArgs: workspace-ro + sandbox run rw + fuse device", () => {
  const opts = defaultOpts({ runArgs: ["arg1"] });
  const args = buildDockerArgs(opts, TEST_OVERLAY);

  assert.ok(args.includes("run"));
  assert.ok(args.includes("--rm"));
  assert.ok(!args.includes("-t"));
  assert.ok(!args.includes("--network"));
  assert.ok(args.includes("ubuntu:24.04"));

  const deviceIdx = args.indexOf("--device");
  assert.ok(deviceIdx >= 0);
  assert.equal(args[deviceIdx + 1], "/dev/fuse");

  const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");

  // Overlay lower-layer ro
  const wsRoMount = vFlags.find((v) => v.includes("/jaiph/workspace-ro:"));
  assert.ok(wsRoMount, "workspace-ro mount present");
  assert.ok(wsRoMount!.endsWith(":ro"), "workspace-ro must be ro");
  assert.ok(!vFlags.some((v) => v.includes("/jaiph/workspace:")), "workspace mount must stay writable inside image");

  // Sandbox run dir rw
  const runMount = vFlags.find((v) => v.includes("/jaiph/run:"));
  assert.ok(runMount, "sandbox run mount present");
  assert.ok(runMount!.endsWith(":rw"), "sandbox run must be rw");

  // Overlay script mounted ro
  const overlayMount = vFlags.find((v) => v.includes("/jaiph/overlay-run.sh:"));
  assert.ok(overlayMount, "overlay script mount present");
  assert.ok(overlayMount!.endsWith(":ro"), "overlay script must be ro");

  // Total: 1 workspace-ro + 1 run + 1 overlay script = 3
  assert.equal(vFlags.length, 3);

  // Command: overlay-run.sh → jaiph run --raw <source>
  assert.ok(args.includes("/jaiph/overlay-run.sh"));
  assert.ok(args.includes("jaiph"));
  assert.ok(args.includes("--raw"));
  assert.ok(args.includes("/jaiph/workspace/main.jh"));
  assert.ok(args.includes("arg1"));
});

test("buildDockerArgs: no -t flag even when isTTY is true", () => {
  const args = buildDockerArgs(defaultOpts({ isTTY: true }), TEST_OVERLAY);
  assert.ok(!args.includes("-t"));
});

test("buildDockerArgs: --network flag for non-default network", () => {
  const opts = defaultOpts({
    config: { ...defaultOpts().config, network: "none" },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  const netIdx = args.indexOf("--network");
  assert.ok(netIdx > 0);
  assert.equal(args[netIdx + 1], "none");
});

test("buildDockerArgs: forwards JAIPH_ env vars, excludes JAIPH_DOCKER_*", () => {
  const opts = defaultOpts({
    env: { JAIPH_DEBUG: "true", JAIPH_DOCKER_IMAGE: "nope", OTHER_VAR: "ignored" },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_DEBUG=true"));
  assert.ok(!args.some((a) => a.includes("JAIPH_DOCKER_IMAGE")));
  assert.ok(!args.some((a) => a.includes("OTHER_VAR")));
});

test("buildDockerArgs: overrides JAIPH_WORKSPACE and JAIPH_RUNS_DIR", () => {
  const opts = defaultOpts({
    env: { JAIPH_WORKSPACE: "/host/path", JAIPH_RUNS_DIR: "/host/runs" },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_WORKSPACE=/jaiph/workspace"));
  assert.ok(args.includes("JAIPH_RUNS_DIR=/jaiph/run"));
  assert.ok(!args.some((a) => a === "JAIPH_WORKSPACE=/host/path"));
  assert.ok(!args.some((a) => a === "JAIPH_RUNS_DIR=/host/runs"));
});

// ---------------------------------------------------------------------------
// buildDockerArgs: agent env var forwarding
// ---------------------------------------------------------------------------

test("buildDockerArgs: forwards ANTHROPIC_* env vars", () => {
  const args = buildDockerArgs(defaultOpts({
    env: { ANTHROPIC_API_KEY: "sk-ant-test-key", ANTHROPIC_BASE_URL: "https://api.example.test" },
  }), TEST_OVERLAY);
  assert.ok(args.includes("ANTHROPIC_API_KEY=sk-ant-test-key"));
  assert.ok(args.includes("ANTHROPIC_BASE_URL=https://api.example.test"));
});

test("buildDockerArgs: forwards CURSOR_* env vars", () => {
  const args = buildDockerArgs(defaultOpts({
    env: { CURSOR_API_KEY: "cursor-key-123", CURSOR_SESSION_ID: "sess-456", OTHER_VAR: "ignored" },
  }), TEST_OVERLAY);
  assert.ok(args.includes("CURSOR_API_KEY=cursor-key-123"));
  assert.ok(args.includes("CURSOR_SESSION_ID=sess-456"));
  assert.ok(!args.some((a) => a.includes("OTHER_VAR")));
});

test("buildDockerArgs: forwards CLAUDE_* env vars", () => {
  const args = buildDockerArgs(defaultOpts({
    env: { CLAUDE_API_KEY: "claude-key-123", CLAUDE_AUTH_TOKEN: "token-456" },
  }), TEST_OVERLAY);
  assert.ok(args.includes("CLAUDE_API_KEY=claude-key-123"));
  assert.ok(args.includes("CLAUDE_AUTH_TOKEN=token-456"));
});

test("buildDockerArgs: does not forward undefined agent env vars", () => {
  const args = buildDockerArgs(defaultOpts({
    env: { ANTHROPIC_API_KEY: undefined, CURSOR_TOKEN: undefined },
  }), TEST_OVERLAY);
  assert.ok(!args.some((a) => a.includes("ANTHROPIC_API_KEY")));
  assert.ok(!args.some((a) => a.includes("CURSOR_TOKEN")));
});

// ---------------------------------------------------------------------------
// remapDockerEnv
// ---------------------------------------------------------------------------

test("remapDockerEnv: overrides JAIPH_WORKSPACE to container path", () => {
  const result = remapDockerEnv({ JAIPH_WORKSPACE: "/home/user/project" });
  assert.equal(result.JAIPH_WORKSPACE, "/jaiph/workspace");
});

test("remapDockerEnv: overrides JAIPH_RUNS_DIR to /jaiph/run", () => {
  const result = remapDockerEnv({ JAIPH_RUNS_DIR: "/home/user/project/.jaiph/runs" });
  assert.equal(result.JAIPH_RUNS_DIR, "/jaiph/run");
});

test("remapDockerEnv: sets JAIPH_RUNS_DIR even when not in input", () => {
  const result = remapDockerEnv({});
  assert.equal(result.JAIPH_RUNS_DIR, "/jaiph/run");
});

test("remapDockerEnv: rewrites JAIPH_AGENT_TRUSTED_WORKSPACE from host workspaceRoot to /jaiph/workspace", () => {
  const result = remapDockerEnv(
    { JAIPH_AGENT_TRUSTED_WORKSPACE: "/tmp/jaiph-run-abcdef" },
    "/tmp/jaiph-run-abcdef",
  );
  assert.equal(result.JAIPH_AGENT_TRUSTED_WORKSPACE, "/jaiph/workspace");
});

test("remapDockerEnv: rewrites a workspace subpath in JAIPH_AGENT_TRUSTED_WORKSPACE", () => {
  const result = remapDockerEnv(
    { JAIPH_AGENT_TRUSTED_WORKSPACE: "/home/me/project/sub/dir" },
    "/home/me/project",
  );
  assert.equal(result.JAIPH_AGENT_TRUSTED_WORKSPACE, "/jaiph/workspace/sub/dir");
});

test("remapDockerEnv: leaves JAIPH_AGENT_TRUSTED_WORKSPACE unchanged when outside workspace", () => {
  const result = remapDockerEnv(
    { JAIPH_AGENT_TRUSTED_WORKSPACE: "/some/other/abs/path" },
    "/home/me/project",
  );
  assert.equal(result.JAIPH_AGENT_TRUSTED_WORKSPACE, "/some/other/abs/path");
});

test("remapDockerEnv: omitted workspaceRoot leaves JAIPH_AGENT_TRUSTED_WORKSPACE intact (back-compat)", () => {
  const result = remapDockerEnv({ JAIPH_AGENT_TRUSTED_WORKSPACE: "/home/me/project" });
  assert.equal(result.JAIPH_AGENT_TRUSTED_WORKSPACE, "/home/me/project");
});

test("resolveDockerHostRunsRoot: defaults under workspace", () => {
  assert.equal(resolveDockerHostRunsRoot(TEST_WS, {}), join(TEST_WS, ".jaiph", "runs"));
});

test("resolveDockerHostRunsRoot: resolves relative path under workspace", () => {
  assert.equal(resolveDockerHostRunsRoot(TEST_WS, { JAIPH_RUNS_DIR: "custom_runs" }), join(TEST_WS, "custom_runs"));
});

test("resolveDockerHostRunsRoot: keeps absolute path inside workspace", () => {
  const abs = join(TEST_WS, "abs_runs");
  assert.equal(resolveDockerHostRunsRoot(TEST_WS, { JAIPH_RUNS_DIR: abs }), abs);
});

test("resolveDockerHostRunsRoot: rejects absolute path outside workspace", () => {
  assert.throws(
    () => resolveDockerHostRunsRoot(TEST_WS, { JAIPH_RUNS_DIR: "/tmp/outside-runs" }),
    /E_DOCKER_RUNS_DIR/,
  );
});

// ---------------------------------------------------------------------------
// overlayMountPath
// ---------------------------------------------------------------------------

test("overlayMountPath: /jaiph/workspace → /jaiph/workspace-ro", () => {
  assert.equal(overlayMountPath("/jaiph/workspace"), "/jaiph/workspace-ro");
});

test("overlayMountPath: subpath remapped", () => {
  assert.equal(overlayMountPath("/jaiph/workspace/config"), "/jaiph/workspace-ro/config");
});

test("overlayMountPath: non-workspace path unchanged", () => {
  assert.equal(overlayMountPath("/other/path"), "/other/path");
});

// ---------------------------------------------------------------------------
// writeOverlayScript
// ---------------------------------------------------------------------------

test("writeOverlayScript: creates executable script with fuse-overlayfs setup", () => {
  const scriptPath = writeOverlayScript();
  try {
    assert.ok(existsSync(scriptPath));
    const content = readFileSync(scriptPath, "utf8");
    assert.ok(content.startsWith("#!/usr/bin/env bash"));
    assert.ok(content.includes("fuse-overlayfs -o"));
    assert.ok(content.includes("lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK"));
    assert.ok(content.includes('exec "$@"'));
    assert.ok(content.includes("E_DOCKER_OVERLAY"));
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

test("writeOverlayScript: mounts as root and then drops to host uid via setpriv", () => {
  const scriptPath = writeOverlayScript();
  try {
    const content = readFileSync(scriptPath, "utf8");
    assert.ok(content.includes("JAIPH_HOST_UID"), "host uid contract present");
    assert.ok(content.includes("JAIPH_HOST_GID"), "host gid contract present");
    assert.ok(content.includes("setpriv"), "drops privileges via setpriv");
    assert.ok(content.includes("chown"), "best-effort chown for /jaiph/run");
    assert.ok(content.includes("allow_other"), "allow_other so dropped uid can use mounted overlay");
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

test("writeOverlayScript: contains no in-container rsync/cp fallback (host handles it now)", () => {
  const scriptPath = writeOverlayScript();
  try {
    const content = readFileSync(scriptPath, "utf8");
    assert.ok(!content.includes("rsync"), "rsync fallback removed from container script");
    assert.ok(!content.includes("copy_workspace_with_cp"), "cp fallback removed from container script");
    assert.ok(!content.includes("rewrite_workspace_path"), "path-rewrite logic removed");
    assert.ok(!content.includes("RUNTIME_WORKSPACE"), "workspace switch logic removed");
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// spawnDockerProcess: stdin must be ignored
// ---------------------------------------------------------------------------

test("spawnDockerProcess: stdin ignored, stdout+stderr piped for events", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(
    src.includes('["ignore", "pipe", "pipe"]'),
    "spawnDockerProcess must use stdio: [\"ignore\", \"pipe\", \"pipe\"]",
  );
});

test("spawnDockerProcess: Linux overlay mode chmods sandbox run dir for userns-remap compatibility", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(src.includes("mode === \"overlay\""), "guarded to overlay mode");
  assert.ok(src.includes("chmodSync(opts.sandboxRunDir, 0o777)"), "run dir chmod present");
});

// ---------------------------------------------------------------------------
// resolveDockerConfig: imageExplicit
// ---------------------------------------------------------------------------

test("resolveDockerConfig: imageExplicit is false when using default", () => {
  const cfg = resolveDockerConfig(undefined, {});
  assert.equal(cfg.imageExplicit, false);
});

test("resolveDockerConfig: imageExplicit is true when env sets image", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_DOCKER_IMAGE: "alpine:3.19" });
  assert.equal(cfg.imageExplicit, true);
  assert.equal(cfg.image, "alpine:3.19");
});

test("resolveDockerConfig: imageExplicit is true when in-file sets image", () => {
  const cfg = resolveDockerConfig({ dockerImage: "alpine:3.19" }, {});
  assert.equal(cfg.imageExplicit, true);
  assert.equal(cfg.image, "alpine:3.19");
});

// ---------------------------------------------------------------------------
// GHCR_IMAGE_REPO
// ---------------------------------------------------------------------------

test("GHCR_IMAGE_REPO: points to official registry", () => {
  assert.equal(GHCR_IMAGE_REPO, "ghcr.io/jaiphlang/jaiph-runtime");
});

// ---------------------------------------------------------------------------
// Strict contract: no on-run workspace Dockerfile build, no npm pack bootstrap
// ---------------------------------------------------------------------------

test("docker.ts: no auto-build or npm-pack bootstrap code", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(!src.includes("npm pack"), "docker.ts must not contain npm pack");
  assert.ok(!src.includes("npm install -g"), "docker.ts must not contain npm install -g");
  assert.ok(!src.includes("jaiph-runtime-auto"), "docker.ts must not reference auto-derived image tag");
  assert.ok(!src.includes("ensureLocalRuntimeImage"), "docker.ts must not contain ensureLocalRuntimeImage");
  assert.ok(!src.includes("buildRuntimeImageFromLocalPackage"), "docker.ts must not contain buildRuntimeImageFromLocalPackage");
  assert.ok(
    /export function resolveImage\(config: DockerRunConfig\): string \{[\s\S]*?pullImageIfNeeded\(image\);[\s\S]*?verifyImageHasJaiph\(image\);/.test(
      src,
    ),
    "resolveImage must pull and verify config.image only (no workspace Dockerfile build)",
  );
});

test("verifyImageHasJaiph: throws E_DOCKER_NO_JAIPH with guidance for missing jaiph", () => {
  // Unit-test the error message structure without running Docker.
  // verifyImageHasJaiph uses imageHasJaiph internally which spawns Docker,
  // so we test the error message format by checking the source contract.
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(src.includes("E_DOCKER_NO_JAIPH"), "verifyImageHasJaiph must use E_DOCKER_NO_JAIPH error code");
  assert.ok(src.includes(GHCR_IMAGE_REPO), "error message must reference official GHCR image");
});

// ---------------------------------------------------------------------------
// validateMountHostPath: dangerous mount rejection
// ---------------------------------------------------------------------------

test("validateMountHostPath: allows normal workspace path", () => {
  assert.doesNotThrow(() => validateMountHostPath("/home/user/project"));
});

test("validateMountHostPath: rejects root filesystem", () => {
  assert.throws(() => validateMountHostPath("/"), /E_VALIDATE_MOUNT.*root filesystem/);
});

test("validateMountHostPath: rejects docker socket", () => {
  assert.throws(() => validateMountHostPath("/var/run/docker.sock"), /E_VALIDATE_MOUNT.*denied/);
});

test("validateMountHostPath: rejects /proc", () => {
  assert.throws(() => validateMountHostPath("/proc"), /E_VALIDATE_MOUNT.*denied/);
});

test("validateMountHostPath: rejects /proc subpath", () => {
  assert.throws(() => validateMountHostPath("/proc/1/root"), /E_VALIDATE_MOUNT.*denied/);
});

test("validateMountHostPath: rejects /sys", () => {
  assert.throws(() => validateMountHostPath("/sys"), /E_VALIDATE_MOUNT.*denied/);
});

test("validateMountHostPath: rejects /dev", () => {
  assert.throws(() => validateMountHostPath("/dev"), /E_VALIDATE_MOUNT.*denied/);
});

test("validateMountHostPath: rejects /run/docker.sock", () => {
  assert.throws(() => validateMountHostPath("/run/docker.sock"), /E_VALIDATE_MOUNT.*denied/);
});

// ---------------------------------------------------------------------------
// isEnvAllowed: env allowlist
// ---------------------------------------------------------------------------

test("isEnvAllowed: allows JAIPH_ vars", () => {
  assert.equal(isEnvAllowed("JAIPH_DEBUG"), true);
});

test("isEnvAllowed: excludes JAIPH_DOCKER_ vars", () => {
  assert.equal(isEnvAllowed("JAIPH_DOCKER_IMAGE"), false);
  assert.equal(isEnvAllowed("JAIPH_DOCKER_ENABLED"), false);
});

test("isEnvAllowed: allows ANTHROPIC_ vars", () => {
  assert.equal(isEnvAllowed("ANTHROPIC_API_KEY"), true);
});

test("isEnvAllowed: allows CURSOR_ vars", () => {
  assert.equal(isEnvAllowed("CURSOR_API_KEY"), true);
});

test("isEnvAllowed: allows CLAUDE_ vars", () => {
  assert.equal(isEnvAllowed("CLAUDE_AUTH_TOKEN"), true);
});

test("isEnvAllowed: rejects SSH_ vars", () => {
  assert.equal(isEnvAllowed("SSH_AUTH_SOCK"), false);
});

test("isEnvAllowed: rejects AWS_ vars", () => {
  assert.equal(isEnvAllowed("AWS_SECRET_ACCESS_KEY"), false);
});

test("isEnvAllowed: rejects GITHUB_TOKEN", () => {
  assert.equal(isEnvAllowed("GITHUB_TOKEN"), false);
});

test("isEnvAllowed: rejects PYPI_TOKEN", () => {
  assert.equal(isEnvAllowed("PYPI_TOKEN"), false);
});

test("isEnvAllowed: rejects arbitrary vars", () => {
  assert.equal(isEnvAllowed("HOME"), false);
  assert.equal(isEnvAllowed("PATH"), false);
  assert.equal(isEnvAllowed("GH_TOKEN"), false);
  assert.equal(isEnvAllowed("CARGO_REGISTRY_TOKEN"), false);
});

test("buildDockerArgs: only forwards env vars matching allowlist", () => {
  const opts = defaultOpts({
    env: {
      JAIPH_DEBUG: "true",
      GITHUB_TOKEN: "x",
      PYPI_TOKEN: "y",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      AWS_SECRET_ACCESS_KEY: "secret",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_DEBUG=true"), "allowed JAIPH_ var forwarded");
  assert.ok(!args.some((a) => a.includes("GITHUB_TOKEN")), "GITHUB_TOKEN not forwarded");
  assert.ok(!args.some((a) => a.includes("PYPI_TOKEN")), "PYPI_TOKEN not forwarded");
  assert.ok(!args.some((a) => a.includes("SSH_AUTH_SOCK")), "SSH_ not forwarded");
  assert.ok(!args.some((a) => a.includes("AWS_SECRET_ACCESS_KEY")), "AWS_ not forwarded");
  assert.ok(!args.some((a) => a.includes("DOCKER_HOST")), "DOCKER_ not forwarded");
});

// ---------------------------------------------------------------------------
// buildDockerArgs: security flags
// ---------------------------------------------------------------------------

test("buildDockerArgs: includes --cap-drop ALL and --security-opt no-new-privileges", () => {
  const args = buildDockerArgs(defaultOpts(), TEST_OVERLAY);
  const capDropIdx = args.indexOf("--cap-drop");
  assert.ok(capDropIdx >= 0, "--cap-drop present");
  assert.equal(args[capDropIdx + 1], "ALL");
  const secOptIdx = args.indexOf("--security-opt");
  assert.ok(secOptIdx >= 0, "--security-opt present");
  assert.equal(args[secOptIdx + 1], "no-new-privileges");
});

test("buildDockerArgs: overlay mode adds SYS_ADMIN + SETUID + SETGID + CHOWN + DAC_READ_SEARCH", () => {
  const args = buildDockerArgs(defaultOpts(), TEST_OVERLAY);
  const capAddValues = args
    .map((v, i) => (v === "--cap-add" ? args[i + 1] : null))
    .filter((v): v is string => v !== null);
  assert.ok(capAddValues.includes("SYS_ADMIN"), "SYS_ADMIN present");
  assert.ok(capAddValues.includes("SETUID"), "SETUID present");
  assert.ok(capAddValues.includes("SETGID"), "SETGID present");
  assert.ok(capAddValues.includes("CHOWN"), "CHOWN present");
  assert.ok(
    capAddValues.includes("DAC_READ_SEARCH"),
    "DAC_READ_SEARCH present so fuse-overlayfs can read host files with restrictive perms",
  );
});

test("buildDockerArgs: copy mode adds no caps", () => {
  const cloneDir = mkdtempSync(join(tmpdir(), "jaiph-test-clone-"));
  try {
    const args = buildDockerArgs(copyOpts(cloneDir));
    const capAddValues = args
      .map((v, i) => (v === "--cap-add" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    assert.deepStrictEqual(capAddValues, [], "copy mode runs with no added capabilities");
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("buildDockerArgs: overlay mode adds --security-opt apparmor=unconfined on Linux to allow fuse mounts", () => {
  if (process.platform !== "linux") return;
  const args = buildDockerArgs(defaultOpts(), TEST_OVERLAY);
  const secOptIndices = args
    .map((v, i) => (v === "--security-opt" ? i : -1))
    .filter((i) => i >= 0);
  const values = secOptIndices.map((i) => args[i + 1]);
  assert.ok(values.includes("apparmor=unconfined"), "apparmor=unconfined present in overlay mode");
});

test("buildDockerArgs: copy mode does not add --security-opt apparmor=unconfined", () => {
  const cloneDir = mkdtempSync(join(tmpdir(), "jaiph-test-clone-"));
  try {
    const args = buildDockerArgs(copyOpts(cloneDir));
    const secOptIndices = args
      .map((v, i) => (v === "--security-opt" ? i : -1))
      .filter((i) => i >= 0);
    const values = secOptIndices.map((i) => args[i + 1]);
    assert.ok(!values.includes("apparmor=unconfined"), "no apparmor flag needed in copy mode");
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildDockerArgs: copy-mode sandbox (host pre-clones workspace, mounts rw)
// ---------------------------------------------------------------------------

test("buildDockerArgs: copy mode mounts cloned workspace rw at /jaiph/workspace and skips overlay/fuse/SYS_ADMIN", () => {
  const cloneDir = mkdtempSync(join(tmpdir(), "jaiph-test-clone-"));
  try {
    const args = buildDockerArgs(copyOpts(cloneDir));
    const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");

    const wsMount = vFlags.find((v) => v.endsWith(":/jaiph/workspace:rw"));
    assert.ok(wsMount, "workspace bound rw at /jaiph/workspace");
    assert.ok(wsMount!.startsWith(`${cloneDir}:`), "host side is the cloned workspace");
    assert.ok(!vFlags.some((v) => v.includes("/jaiph/workspace-ro")), "no overlay lower-layer mount in copy mode");
    assert.ok(!vFlags.some((v) => v.includes("/jaiph/overlay-run.sh")), "no overlay script mount in copy mode");

    assert.ok(!args.includes("/dev/fuse"), "no fuse device in copy mode");
    assert.ok(!args.includes("SYS_ADMIN"), "no SYS_ADMIN cap in copy mode");

    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("--security-opt"));
    assert.ok(args.includes("no-new-privileges"));

    const idxImage = args.indexOf("ubuntu:24.04");
    const tail = args.slice(idxImage + 1);
    assert.equal(tail[0], "jaiph", "no overlay-run.sh wrapper in copy mode");
    assert.equal(tail[1], "run");
    assert.equal(tail[2], "--raw");
    assert.equal(tail[3], "/jaiph/workspace/main.jh");
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("buildDockerArgs: copy mode binds run dir rw at /jaiph/run", () => {
  const cloneDir = mkdtempSync(join(tmpdir(), "jaiph-test-clone-"));
  try {
    const args = buildDockerArgs(copyOpts(cloneDir));
    const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
    const runMount = vFlags.find((v) => v.endsWith(":/jaiph/run:rw"));
    assert.ok(runMount, "run dir bound rw at /jaiph/run");
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("buildDockerArgs: throws when overlay mode is selected without script path", () => {
  assert.throws(() => buildDockerArgs(defaultOpts({ sandboxMode: "overlay" })), /overlay mode requires/);
});

// ---------------------------------------------------------------------------
// buildDockerArgs: UID/GID handling (Linux only)
// ---------------------------------------------------------------------------

test("buildDockerArgs: overlay mode runs as root and injects JAIPH_HOST_UID/GID (Linux)", () => {
  if (process.platform !== "linux") return;
  const args = buildDockerArgs(defaultOpts(), TEST_OVERLAY);
  const userIdx = args.indexOf("--user");
  assert.ok(userIdx >= 0, "--user flag present");
  assert.equal(args[userIdx + 1], "0:0", "overlay starts as root so fuse-overlayfs can mount /jaiph/workspace");

  const envFlags = args
    .map((v, i) => (v === "-e" ? args[i + 1] : null))
    .filter((v): v is string => v !== null);
  assert.ok(envFlags.some((v) => v.startsWith("JAIPH_HOST_UID=")), "JAIPH_HOST_UID env present");
  assert.ok(envFlags.some((v) => v.startsWith("JAIPH_HOST_GID=")), "JAIPH_HOST_GID env present");
});

test("buildDockerArgs: copy mode runs as host UID:GID directly (Linux)", () => {
  if (process.platform !== "linux") return;
  const cloneDir = mkdtempSync(join(tmpdir(), "jaiph-test-clone-"));
  try {
    const args = buildDockerArgs(copyOpts(cloneDir));
    const userIdx = args.indexOf("--user");
    assert.ok(userIdx >= 0, "--user flag present");
    assert.notEqual(args[userIdx + 1], "0:0", "copy mode runs as host UID, not root");
    assert.match(args[userIdx + 1], /^\d+:\d+$/, "copy mode --user is uid:gid");

    const envFlags = args
      .map((v, i) => (v === "-e" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    assert.ok(!envFlags.some((v) => v.startsWith("JAIPH_HOST_UID=")), "no JAIPH_HOST_UID env in copy mode");
    assert.ok(!envFlags.some((v) => v.startsWith("JAIPH_HOST_GID=")), "no JAIPH_HOST_GID env in copy mode");
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("buildDockerArgs: throws when copy mode is selected without sandboxWorkspaceDir", () => {
  assert.throws(
    () => buildDockerArgs(defaultOpts({ sandboxMode: "copy", sandboxWorkspaceDir: undefined })),
    /copy mode requires sandboxWorkspaceDir/,
  );
});

// ---------------------------------------------------------------------------
// selectSandboxMode
// ---------------------------------------------------------------------------

test("selectSandboxMode: JAIPH_DOCKER_NO_OVERLAY=1 forces copy", () => {
  assert.equal(selectSandboxMode({ JAIPH_DOCKER_NO_OVERLAY: "1" }), "copy");
  assert.equal(selectSandboxMode({ JAIPH_DOCKER_NO_OVERLAY: "true" }), "copy");
});

test("selectSandboxMode: returns overlay iff /dev/fuse exists on host (platform-correlated)", () => {
  const expected = existsSync("/dev/fuse") ? "overlay" : "copy";
  assert.equal(selectSandboxMode({}), expected);
});

// ---------------------------------------------------------------------------
// cloneWorkspaceForSandbox + allocateSandboxWorkspaceDir
// ---------------------------------------------------------------------------

test("cloneWorkspaceForSandbox: copies entries and excludes .jaiph/runs", () => {
  const src = mkdtempSync(join(tmpdir(), "jaiph-clone-src-"));
  const dst = mkdtempSync(join(tmpdir(), "jaiph-clone-dst-"));
  try {
    writeFileSync(join(src, "file.txt"), "hello");
    mkdirSync(join(src, "subdir"), { recursive: true });
    writeFileSync(join(src, "subdir", "nested.txt"), "nested");
    mkdirSync(join(src, ".jaiph"), { recursive: true });
    writeFileSync(join(src, ".jaiph", "engineer.jh"), "wf");
    mkdirSync(join(src, ".jaiph", "runs", "2026-01-01"), { recursive: true });
    writeFileSync(join(src, ".jaiph", "runs", "2026-01-01", "log.txt"), "PII");

    cloneWorkspaceForSandbox(src, dst);

    assert.equal(readFileSync(join(dst, "file.txt"), "utf8"), "hello");
    assert.equal(readFileSync(join(dst, "subdir", "nested.txt"), "utf8"), "nested");
    assert.equal(readFileSync(join(dst, ".jaiph", "engineer.jh"), "utf8"), "wf");
    assert.ok(!existsSync(join(dst, ".jaiph", "runs")), ".jaiph/runs must NOT be copied");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test("cloneWorkspaceForSandbox: produces independent file inodes (writes do not leak to source)", () => {
  // Guards against the broken cp-rl/hardlink design we explicitly avoided.
  const src = mkdtempSync(join(tmpdir(), "jaiph-clone-src-"));
  const dst = mkdtempSync(join(tmpdir(), "jaiph-clone-dst-"));
  try {
    writeFileSync(join(src, "leak-check.txt"), "original");
    cloneWorkspaceForSandbox(src, dst);
    writeFileSync(join(dst, "leak-check.txt"), "mutated-by-container");
    assert.equal(
      readFileSync(join(src, "leak-check.txt"), "utf8"),
      "original",
      "host file must not be mutated by writes inside the cloned workspace",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test("cloneWorkspaceForSandbox: empty workspace produces empty clone", () => {
  const src = mkdtempSync(join(tmpdir(), "jaiph-clone-src-"));
  const dst = mkdtempSync(join(tmpdir(), "jaiph-clone-dst-"));
  try {
    cloneWorkspaceForSandbox(src, dst);
    assert.deepStrictEqual(readdirSync(dst), []);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test("allocateSandboxWorkspaceDir: creates a fresh .sandbox-* dir under the runs root", () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "jaiph-runs-"));
  try {
    const a = allocateSandboxWorkspaceDir(runsRoot);
    const b = allocateSandboxWorkspaceDir(runsRoot);
    assert.notEqual(a, b);
    assert.ok(a.startsWith(join(runsRoot, ".sandbox-")));
    assert.ok(b.startsWith(join(runsRoot, ".sandbox-")));
    assert.ok(existsSync(a) && existsSync(b));
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pullImageIfNeeded: shell metacharacter safety (execFileSync migration)
// ---------------------------------------------------------------------------

test("pullImageIfNeeded: image with semicolon is passed verbatim, no shell expansion", () => {
  const captured: string[][] = [];
  const original = _dockerExec.run;
  _dockerExec.run = (args: string[], _opts: object) => {
    captured.push([...args]);
    // Simulate "image inspect" succeeding (image already present)
  };
  try {
    pullImageIfNeeded("alpine; echo pwned");
    assert.equal(captured.length, 1, "exactly one docker call (image inspect)");
    assert.deepStrictEqual(captured[0], ["image", "inspect", "alpine; echo pwned"]);
  } finally {
    _dockerExec.run = original;
  }
});

test("pullImageIfNeeded: semicolon image passed verbatim to docker pull on inspect failure", () => {
  const captured: string[][] = [];
  const original = _dockerExec.run;
  _dockerExec.run = (args: string[], _opts: object) => {
    captured.push([...args]);
    if (args[0] === "image") throw new Error("not found");
    // docker pull succeeds
  };
  try {
    pullImageIfNeeded("alpine; echo pwned");
    assert.equal(captured.length, 2, "inspect + pull");
    assert.deepStrictEqual(captured[0], ["image", "inspect", "alpine; echo pwned"]);
    assert.deepStrictEqual(captured[1], ["pull", "alpine; echo pwned"]);
  } finally {
    _dockerExec.run = original;
  }
});

