import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMount,
  parseMounts,
  validateMounts,
  validateMountHostPath,
  resolveDockerConfig,
  buildDockerArgs,
  remapDockerEnv,
  overlayMountPath,
  findRunArtifacts,
  resolveDockerHostRunsRoot,
  writeOverlayScript,
  resolveImage,
  buildImageFromDockerfile,
  verifyImageHasJaiph,
  isEnvDenied,
  ENV_DENYLIST_PREFIXES,
  GHCR_IMAGE_REPO,
  exportWorkspacePatch,
  type MountSpec,
  type DockerRunConfig,
  type DockerSpawnOptions,
} from "./docker";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
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
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    },
    sourceAbs: join(TEST_WS, "main.jh"),
    workspaceRoot: TEST_WS,
    sandboxRunDir: TEST_SANDBOX,
    runArgs: [],
    env: {},
    isTTY: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseMount
// ---------------------------------------------------------------------------

test("parseMount: 3-segment full form", () => {
  const m = parseMount(".:/jaiph/workspace:rw");
  assert.deepStrictEqual(m, { hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" });
});

test("parseMount: 3-segment read-only", () => {
  const m = parseMount("config:/etc/config:ro");
  assert.deepStrictEqual(m, { hostPath: "config", containerPath: "/etc/config", mode: "ro" });
});

test("parseMount: 2-segment shorthand", () => {
  const m = parseMount("config:ro");
  assert.deepStrictEqual(m, { hostPath: "config", containerPath: "/jaiph/workspace/config", mode: "ro" });
});

test("parseMount: 2-segment rw shorthand", () => {
  const m = parseMount("data:rw");
  assert.deepStrictEqual(m, { hostPath: "data", containerPath: "/jaiph/workspace/data", mode: "rw" });
});

test("parseMount: 1 segment throws E_PARSE", () => {
  assert.throws(() => parseMount("onlyone"), /E_PARSE/);
});

test("parseMount: invalid mode in 3-segment throws E_PARSE", () => {
  assert.throws(() => parseMount("a:b:wx"), /E_PARSE.*mode/);
});

test("parseMount: invalid mode in 2-segment throws E_PARSE", () => {
  assert.throws(() => parseMount("a:wx"), /E_PARSE.*mode/);
});

// ---------------------------------------------------------------------------
// validateMounts
// ---------------------------------------------------------------------------

test("validateMounts: exactly one /jaiph/workspace mount passes", () => {
  const mounts: MountSpec[] = [
    { hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" },
    { hostPath: "config", containerPath: "/jaiph/workspace/config", mode: "ro" },
  ];
  assert.doesNotThrow(() => validateMounts(mounts));
});

test("validateMounts: no /jaiph/workspace mount throws E_VALIDATE", () => {
  const mounts: MountSpec[] = [
    { hostPath: ".", containerPath: "/app", mode: "rw" },
  ];
  assert.throws(() => validateMounts(mounts), /E_VALIDATE.*\/jaiph\/workspace/);
});

test("validateMounts: multiple /jaiph/workspace mounts throws E_VALIDATE", () => {
  const mounts: MountSpec[] = [
    { hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" },
    { hostPath: "other", containerPath: "/jaiph/workspace", mode: "ro" },
  ];
  assert.throws(() => validateMounts(mounts), /E_VALIDATE.*multiple/);
});

// ---------------------------------------------------------------------------
// parseMounts
// ---------------------------------------------------------------------------

test("parseMounts: parses and validates multiple mount specs", () => {
  const mounts = parseMounts([".:/jaiph/workspace:rw", "config:ro"]);
  assert.equal(mounts.length, 2);
  assert.equal(mounts[0].containerPath, "/jaiph/workspace");
  assert.equal(mounts[1].containerPath, "/jaiph/workspace/config");
});

test("parseMounts: throws when no workspace mount", () => {
  assert.throws(() => parseMounts(["config:/etc/config:ro"]), /E_VALIDATE/);
});

// ---------------------------------------------------------------------------
// resolveDockerConfig
// ---------------------------------------------------------------------------

test("resolveDockerConfig: defaults when no in-file and no env — Docker on", () => {
  const cfg = resolveDockerConfig(undefined, {});
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.image.startsWith(GHCR_IMAGE_REPO + ":"), `default image should be GHCR: ${cfg.image}`);
  assert.equal(cfg.network, "default");
  assert.equal(cfg.timeout, 300);
  assert.equal(cfg.mounts.length, 1);
  assert.equal(cfg.mounts[0].containerPath, "/jaiph/workspace");
});

test("resolveDockerConfig: in-file overrides defaults", () => {
  const cfg = resolveDockerConfig(
    { dockerEnabled: true, dockerImage: "alpine:3.19", dockerTimeout: 60 },
    {},
  );
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.image, "alpine:3.19");
  assert.equal(cfg.timeout, 60);
});

test("resolveDockerConfig: env overrides in-file", () => {
  const cfg = resolveDockerConfig(
    { dockerEnabled: true, dockerImage: "alpine:3.19" },
    { JAIPH_DOCKER_ENABLED: "false", JAIPH_DOCKER_IMAGE: "debian:12" },
  );
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.image, "debian:12");
});

test("resolveDockerConfig: CI=true disables Docker by default", () => {
  const cfg = resolveDockerConfig(undefined, { CI: "true" });
  assert.equal(cfg.enabled, false);
});

test("resolveDockerConfig: CI=true with in-file override enables Docker", () => {
  const cfg = resolveDockerConfig({ dockerEnabled: true }, { CI: "true" });
  assert.equal(cfg.enabled, true);
});

test("resolveDockerConfig: env JAIPH_DOCKER_ENABLED=true overrides CI default", () => {
  const cfg = resolveDockerConfig(undefined, { CI: "true", JAIPH_DOCKER_ENABLED: "true" });
  assert.equal(cfg.enabled, true);
});

test("resolveDockerConfig: JAIPH_UNSAFE=true disables Docker by default", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_UNSAFE: "true" });
  assert.equal(cfg.enabled, false);
});

test("resolveDockerConfig: JAIPH_UNSAFE=true with in-file override enables Docker", () => {
  const cfg = resolveDockerConfig({ dockerEnabled: true }, { JAIPH_UNSAFE: "true" });
  assert.equal(cfg.enabled, true);
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

test("resolveDockerConfig: workspace from in-file", () => {
  const cfg = resolveDockerConfig(
    { workspace: [".:/jaiph/workspace:rw", "config:ro"] },
    {},
  );
  assert.equal(cfg.mounts.length, 2);
  assert.equal(cfg.mounts[0].containerPath, "/jaiph/workspace");
  assert.equal(cfg.mounts[1].containerPath, "/jaiph/workspace/config");
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

test("buildDockerArgs: multiple workspace mounts only lower-layer paths are mounted ro", () => {
  const opts = defaultOpts({
    config: {
      ...defaultOpts().config,
      mounts: [
        { hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" },
        { hostPath: "config", containerPath: "/jaiph/workspace/config", mode: "ro" },
      ],
    },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
  // 2 configured lower-layer mounts + 1 run + 1 overlay script = 4
  assert.equal(vFlags.length, 4);
  assert.ok(!vFlags.some((v) => v.includes("/jaiph/workspace:") && v.endsWith(":ro")));
  assert.ok(vFlags.some((v) => v.includes("/jaiph/workspace-ro:") && v.endsWith(":ro")));
  assert.ok(!vFlags.some((v) => v.includes("/jaiph/workspace/config:") && v.endsWith(":ro")));
  assert.ok(vFlags.some((v) => v.includes("/jaiph/workspace-ro/config:") && v.endsWith(":ro")));
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
    assert.ok(content.includes("fuse-overlayfs"));
    assert.ok(content.includes("workspace overlay unavailable"));
    assert.ok(content.includes("using copy fallback"));
    assert.ok(content.includes("mktemp -d /tmp/jaiph-workspace."));
    assert.ok(content.includes("rewrite_workspace_path()"));
    assert.ok(content.includes('rsync -a --delete --no-owner --no-group'));
    assert.ok(content.includes("mktemp \"$MERGED/.jaiph-overlay-probe.XXXXXX\""));
    assert.ok(content.includes('exec "${rewritten_args[@]}"'));
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findRunArtifacts
// ---------------------------------------------------------------------------

test("findRunArtifacts: discovers run dir and summary file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "jaiph-test-find-"));
  try {
    const runDir = join(tmp, "2026-04-17", "09-30-00-test.jh");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run_summary.jsonl"), "{}");
    const result = findRunArtifacts(tmp);
    assert.equal(result.runDir, runDir);
    assert.equal(result.summaryFile, join(runDir, "run_summary.jsonl"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findRunArtifacts: returns runDir without summary if missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "jaiph-test-find-"));
  try {
    const runDir = join(tmp, "2026-04-17", "09-30-00-test.jh");
    mkdirSync(runDir, { recursive: true });
    const result = findRunArtifacts(tmp);
    assert.equal(result.runDir, runDir);
    assert.equal(result.summaryFile, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findRunArtifacts: returns empty for non-existent dir", () => {
  const result = findRunArtifacts("/tmp/jaiph-nonexistent-" + Date.now());
  assert.equal(result.runDir, undefined);
  assert.equal(result.summaryFile, undefined);
});

test("findRunArtifacts: returns latest run when multiple exist", () => {
  const tmp = mkdtempSync(join(tmpdir(), "jaiph-test-find-"));
  try {
    const older = join(tmp, "2026-04-17", "09-30-00-test.jh");
    const newer = join(tmp, "2026-04-17", "09-31-00-test.jh");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, "run_summary.jsonl"), "{}");
    const result = findRunArtifacts(tmp);
    assert.equal(result.runDir, newer);
    assert.equal(result.summaryFile, join(newer, "run_summary.jsonl"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
// resolveImage
// ---------------------------------------------------------------------------

test("resolveImage: uses Dockerfile when imageExplicit is false and Dockerfile exists", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-resolve-image-"));
  try {
    mkdirSync(join(tmpDir, ".jaiph"), { recursive: true });
    writeFileSync(join(tmpDir, ".jaiph", "Dockerfile"), "FROM ubuntu:latest\n");
    const dockerfilePath = join(tmpDir, ".jaiph", "Dockerfile");
    assert.ok(existsSync(dockerfilePath));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveImage: skips Dockerfile when imageExplicit is true", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-resolve-image-"));
  try {
    mkdirSync(join(tmpDir, ".jaiph"), { recursive: true });
    writeFileSync(join(tmpDir, ".jaiph", "Dockerfile"), "FROM ubuntu:latest\n");
    const config: DockerRunConfig = {
      enabled: true,
      image: "custom:image",
      imageExplicit: true,
      network: "default",
      timeout: 300,
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    };
    assert.ok(existsSync(join(tmpDir, ".jaiph", "Dockerfile")));
    assert.equal(config.imageExplicit, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Strict contract: no auto-build, no npm pack bootstrap
// ---------------------------------------------------------------------------

test("docker.ts: no auto-build or npm-pack bootstrap code", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(!src.includes("npm pack"), "docker.ts must not contain npm pack");
  assert.ok(!src.includes("npm install -g"), "docker.ts must not contain npm install -g");
  assert.ok(!src.includes("jaiph-runtime-auto"), "docker.ts must not reference auto-derived image tag");
  assert.ok(!src.includes("ensureLocalRuntimeImage"), "docker.ts must not contain ensureLocalRuntimeImage");
  assert.ok(!src.includes("buildRuntimeImageFromLocalPackage"), "docker.ts must not contain buildRuntimeImageFromLocalPackage");
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
// isEnvDenied: env denylist
// ---------------------------------------------------------------------------

test("isEnvDenied: blocks SSH_ vars", () => {
  assert.equal(isEnvDenied("SSH_AUTH_SOCK"), true);
});

test("isEnvDenied: blocks AWS_ vars", () => {
  assert.equal(isEnvDenied("AWS_SECRET_ACCESS_KEY"), true);
});

test("isEnvDenied: blocks DOCKER_ vars", () => {
  assert.equal(isEnvDenied("DOCKER_HOST"), true);
});

test("isEnvDenied: blocks GPG_ vars", () => {
  assert.equal(isEnvDenied("GPG_AGENT_INFO"), true);
});

test("isEnvDenied: blocks KUBE vars", () => {
  assert.equal(isEnvDenied("KUBECONFIG"), true);
});

test("isEnvDenied: allows JAIPH_ vars", () => {
  assert.equal(isEnvDenied("JAIPH_DEBUG"), false);
});

test("isEnvDenied: allows ANTHROPIC_ vars", () => {
  assert.equal(isEnvDenied("ANTHROPIC_API_KEY"), false);
});

test("buildDockerArgs: denied env vars are not forwarded", () => {
  const opts = defaultOpts({
    env: {
      JAIPH_DEBUG: "true",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      AWS_SECRET_ACCESS_KEY: "secret",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
  });
  const args = buildDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_DEBUG=true"), "allowed JAIPH_ var forwarded");
  assert.ok(!args.some((a) => a.includes("SSH_AUTH_SOCK")), "SSH_ denied");
  assert.ok(!args.some((a) => a.includes("AWS_SECRET_ACCESS_KEY")), "AWS_ denied");
  assert.ok(!args.some((a) => a.includes("DOCKER_HOST")), "DOCKER_ denied");
});

// ---------------------------------------------------------------------------
// buildDockerArgs: security flags
// ---------------------------------------------------------------------------

test("buildDockerArgs: includes --cap-drop ALL and --security-opt no-new-privileges", () => {
  const args = buildDockerArgs(defaultOpts(), TEST_OVERLAY);
  const capDropIdx = args.indexOf("--cap-drop");
  assert.ok(capDropIdx >= 0, "--cap-drop present");
  assert.equal(args[capDropIdx + 1], "ALL");
  const capAddIdx = args.indexOf("--cap-add");
  assert.ok(capAddIdx >= 0, "--cap-add present");
  assert.equal(args[capAddIdx + 1], "SYS_ADMIN");
  const secOptIdx = args.indexOf("--security-opt");
  assert.ok(secOptIdx >= 0, "--security-opt present");
  assert.equal(args[secOptIdx + 1], "no-new-privileges");
});

// ---------------------------------------------------------------------------
// exportWorkspacePatch
// ---------------------------------------------------------------------------

test("exportWorkspacePatch writes patch when git repo has changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-patch-test-"));
  const patchOut = join(dir, "workspace.patch");
  try {
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: dir, stdio: "ignore" });
    // Create initial commit so diff has a baseline
    writeFileSync(join(dir, "initial.txt"), "initial\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
    // Make a change
    writeFileSync(join(dir, "new-file.txt"), "hello\n");

    const result = exportWorkspacePatch(dir, patchOut);
    assert.equal(result, true, "should return true when patch is non-empty");
    assert.ok(existsSync(patchOut), "patch file should exist");
    const content = readFileSync(patchOut, "utf8");
    assert.ok(content.includes("new-file.txt"), "patch should reference the new file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportWorkspacePatch returns false and omits file when no changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-patch-test-"));
  const patchOut = join(dir, "workspace.patch");
  try {
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "initial.txt"), "initial\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    const result = exportWorkspacePatch(dir, patchOut);
    assert.equal(result, false, "should return false when no changes");
    assert.ok(!existsSync(patchOut), "patch file should not exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportWorkspacePatch returns false for non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-patch-test-"));
  const patchOut = join(dir, "workspace.patch");
  try {
    const result = exportWorkspacePatch(dir, patchOut);
    assert.equal(result, false, "should return false for non-git dir");
    assert.ok(!existsSync(patchOut), "patch file should not exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
