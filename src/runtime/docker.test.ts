import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMountHostPath,
  findRunArtifacts,
  isEnvDenied,
  ENV_DENYLIST_PREFIXES,
  GHCR_IMAGE_REPO,
  exportWorkspacePatch,
  buildIsolatedDockerArgs,
  resolveIsolatedImage,
  writeIsolatedOverlayScript,
  type IsolatedSpawnOptions,
} from "./docker";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

/** Shared temp workspace for buildIsolatedDockerArgs tests. */
const TEST_WS = mkdtempSync(join(tmpdir(), "jaiph-test-ws-"));
const TEST_SANDBOX = mkdtempSync(join(tmpdir(), "jaiph-test-sandbox-"));
const TEST_OVERLAY = writeIsolatedOverlayScript();
const TEST_OVERLAY_DIR = dirname(TEST_OVERLAY);
test.after(() => {
  rmSync(TEST_WS, { recursive: true, force: true });
  rmSync(TEST_SANDBOX, { recursive: true, force: true });
  rmSync(TEST_OVERLAY_DIR, { recursive: true, force: true });
});

function defaultIsolatedOpts(overrides?: Partial<IsolatedSpawnOptions>): IsolatedSpawnOptions {
  return {
    sourceAbs: join(TEST_WS, "main.jh"),
    workspaceRoot: TEST_WS,
    branchRunDir: TEST_SANDBOX,
    workflowName: "review",
    runArgs: [],
    env: {},
    image: "ubuntu:24.04",
    network: "default",
    timeout: 300,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// JAIPH_DOCKER_ENABLED is not honored
// ---------------------------------------------------------------------------

test("JAIPH_DOCKER_ENABLED has no effect — no resolveDockerConfig export", () => {
  // The whole-program Docker mode has been removed. JAIPH_DOCKER_ENABLED is
  // not read by any code path. Verify the env var is not referenced in the
  // production source.
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(!src.includes("JAIPH_DOCKER_ENABLED"), "docker.ts must not reference JAIPH_DOCKER_ENABLED");
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

// ---------------------------------------------------------------------------
// GHCR_IMAGE_REPO
// ---------------------------------------------------------------------------

test("GHCR_IMAGE_REPO: points to official registry", () => {
  assert.equal(GHCR_IMAGE_REPO, "ghcr.io/jaiphlang/jaiph-runtime");
});

// ---------------------------------------------------------------------------
// resolveIsolatedImage
// ---------------------------------------------------------------------------

test("resolveIsolatedImage: uses JAIPH_ISOLATED_IMAGE when set", () => {
  const image = resolveIsolatedImage({ JAIPH_ISOLATED_IMAGE: "custom:latest" });
  assert.equal(image, "custom:latest");
});

test("resolveIsolatedImage: falls back to default GHCR image", () => {
  const image = resolveIsolatedImage({});
  assert.ok(image.startsWith(GHCR_IMAGE_REPO + ":"), `default image should be GHCR: ${image}`);
});

// ---------------------------------------------------------------------------
// buildIsolatedDockerArgs
// ---------------------------------------------------------------------------

test("buildIsolatedDockerArgs: workspace-ro + branch run rw + fuse device", () => {
  const opts = defaultIsolatedOpts({ runArgs: ["arg1"] });
  const args = buildIsolatedDockerArgs(opts, TEST_OVERLAY);

  assert.ok(args.includes("run"));
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("ubuntu:24.04"));

  const deviceIdx = args.indexOf("--device");
  assert.ok(deviceIdx >= 0);
  assert.equal(args[deviceIdx + 1], "/dev/fuse");

  const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");

  // Overlay lower-layer ro
  const wsRoMount = vFlags.find((v) => v.includes("/jaiph/workspace-ro:"));
  assert.ok(wsRoMount, "workspace-ro mount present");
  assert.ok(wsRoMount!.endsWith(":ro"), "workspace-ro must be ro");

  // Branch run dir rw
  const runMount = vFlags.find((v) => v.includes("/jaiph/run:"));
  assert.ok(runMount, "branch run mount present");
  assert.ok(runMount!.endsWith(":rw"), "branch run must be rw");

  // Overlay script mounted ro
  const overlayMount = vFlags.find((v) => v.includes("/jaiph/overlay-run.sh:"));
  assert.ok(overlayMount, "overlay script mount present");
  assert.ok(overlayMount!.endsWith(":ro"), "overlay script must be ro");

  // Total: 1 workspace-ro + 1 run + 1 overlay script = 3
  assert.equal(vFlags.length, 3);

  // Command: overlay-run.sh → jaiph run --raw --entry <workflow>
  assert.ok(args.includes("/jaiph/overlay-run.sh"));
  assert.ok(args.includes("jaiph"));
  assert.ok(args.includes("--raw"));
  assert.ok(args.includes("--entry"));
  assert.ok(args.includes("review"));
  assert.ok(args.includes("arg1"));
});

test("buildIsolatedDockerArgs: --network flag for non-default network", () => {
  const opts = defaultIsolatedOpts({ network: "none" });
  const args = buildIsolatedDockerArgs(opts, TEST_OVERLAY);
  const netIdx = args.indexOf("--network");
  assert.ok(netIdx > 0);
  assert.equal(args[netIdx + 1], "none");
});

test("buildIsolatedDockerArgs: forwards JAIPH_ env vars, excludes JAIPH_DOCKER_*", () => {
  const opts = defaultIsolatedOpts({
    env: { JAIPH_DEBUG: "true", JAIPH_DOCKER_IMAGE: "nope", OTHER_VAR: "ignored" },
  });
  const args = buildIsolatedDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_DEBUG=true"));
  assert.ok(!args.some((a) => a.includes("JAIPH_DOCKER_IMAGE")));
  assert.ok(!args.some((a) => a.includes("OTHER_VAR")));
});

test("buildIsolatedDockerArgs: sets JAIPH_ISOLATED=1 sentinel", () => {
  const args = buildIsolatedDockerArgs(defaultIsolatedOpts(), TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_ISOLATED=1"));
});

test("buildIsolatedDockerArgs: forwards agent env vars (ANTHROPIC_, CURSOR_, CLAUDE_)", () => {
  const opts = defaultIsolatedOpts({
    env: { ANTHROPIC_API_KEY: "sk-ant-test", CURSOR_TOKEN: "ct-123", CLAUDE_KEY: "ck-456" },
  });
  const args = buildIsolatedDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("ANTHROPIC_API_KEY=sk-ant-test"));
  assert.ok(args.includes("CURSOR_TOKEN=ct-123"));
  assert.ok(args.includes("CLAUDE_KEY=ck-456"));
});

test("buildIsolatedDockerArgs: denied env vars are not forwarded", () => {
  const opts = defaultIsolatedOpts({
    env: {
      JAIPH_DEBUG: "true",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      AWS_SECRET_ACCESS_KEY: "secret",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
  });
  const args = buildIsolatedDockerArgs(opts, TEST_OVERLAY);
  assert.ok(args.includes("JAIPH_DEBUG=true"), "allowed JAIPH_ var forwarded");
  assert.ok(!args.some((a) => a.includes("SSH_AUTH_SOCK")), "SSH_ denied");
  assert.ok(!args.some((a) => a.includes("AWS_SECRET_ACCESS_KEY")), "AWS_ denied");
  assert.ok(!args.some((a) => a.includes("DOCKER_HOST")), "DOCKER_ denied");
});

test("buildIsolatedDockerArgs: includes --cap-drop ALL (no --security-opt no-new-privileges)", () => {
  const args = buildIsolatedDockerArgs(defaultIsolatedOpts(), TEST_OVERLAY);
  const capDropIdx = args.indexOf("--cap-drop");
  assert.ok(capDropIdx >= 0, "--cap-drop present");
  assert.equal(args[capDropIdx + 1], "ALL");
  const capAddIdx = args.indexOf("--cap-add");
  assert.ok(capAddIdx >= 0, "--cap-add present");
  assert.equal(args[capAddIdx + 1], "SYS_ADMIN");
  // Isolated does NOT set no-new-privileges (fusermount3 needs setuid)
  assert.ok(!args.includes("no-new-privileges"), "no-new-privileges must not be set for isolated");
});

// ---------------------------------------------------------------------------
// writeIsolatedOverlayScript
// ---------------------------------------------------------------------------

test("writeIsolatedOverlayScript: creates strict overlay script (no fallback chain)", () => {
  const scriptPath = writeIsolatedOverlayScript();
  try {
    assert.ok(existsSync(scriptPath));
    const content = readFileSync(scriptPath, "utf8");
    assert.ok(content.startsWith("#!/usr/bin/env bash"));
    assert.ok(content.includes("fuse-overlayfs"));
    assert.ok(!content.includes("rsync"), "strict overlay must not have rsync fallback");
    assert.ok(!content.includes("cp -a"), "strict overlay must not have cp fallback");
    assert.ok(content.includes('exec "$@"'));
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
// spawnIsolatedProcess: stdin must be ignored
// ---------------------------------------------------------------------------

test("spawnIsolatedProcess: stdin ignored, stdout+stderr piped for events", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(
    src.includes('["ignore", "pipe", "pipe"]'),
    "spawnIsolatedProcess must use stdio: [\"ignore\", \"pipe\", \"pipe\"]",
  );
});

// ---------------------------------------------------------------------------
// Strict contract: no auto-build, no npm pack bootstrap, no whole-program Docker
// ---------------------------------------------------------------------------

test("docker.ts: no auto-build or npm-pack bootstrap code", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(!src.includes("npm pack"), "docker.ts must not contain npm pack");
  assert.ok(!src.includes("npm install -g"), "docker.ts must not contain npm install -g");
  assert.ok(!src.includes("jaiph-runtime-auto"), "docker.ts must not reference auto-derived image tag");
  assert.ok(!src.includes("ensureLocalRuntimeImage"), "docker.ts must not contain ensureLocalRuntimeImage");
  assert.ok(!src.includes("buildRuntimeImageFromLocalPackage"), "docker.ts must not contain buildRuntimeImageFromLocalPackage");
});

test("docker.ts: no whole-program Docker mode exports", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(!src.includes("resolveDockerConfig"), "resolveDockerConfig must be removed");
  assert.ok(!src.includes("spawnDockerProcess"), "spawnDockerProcess must be removed");
  assert.ok(!src.includes("cleanupDocker"), "cleanupDocker must be removed");
  assert.ok(!src.includes("DockerRunConfig"), "DockerRunConfig must be removed");
  assert.ok(!src.includes("JAIPH_DOCKER_ENABLED"), "JAIPH_DOCKER_ENABLED must not be referenced");
});

test("verifyImageHasJaiph: throws E_DOCKER_NO_JAIPH with guidance for missing jaiph", () => {
  const src = readFileSync(join(__dirname, "docker.ts"), "utf8");
  assert.ok(src.includes("E_DOCKER_NO_JAIPH"), "verifyImageHasJaiph must use E_DOCKER_NO_JAIPH error code");
  assert.ok(src.includes(GHCR_IMAGE_REPO), "error message must reference official GHCR image");
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
