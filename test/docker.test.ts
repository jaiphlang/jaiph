import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMount,
  parseMounts,
  validateMounts,
  resolveDockerConfig,
  buildDockerArgs,
  prepareGeneratedDir,
  type MountSpec,
  type DockerSpawnOptions,
} from "../src/runtime/docker";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("resolveDockerConfig: defaults when no in-file and no env", () => {
  const cfg = resolveDockerConfig(undefined, {});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.image, "ubuntu:24.04");
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
// prepareGeneratedDir
// ---------------------------------------------------------------------------

test("prepareGeneratedDir: copies script and stdlib", () => {
  const srcDir = mkdtempSync(join(tmpdir(), "jaiph-docker-test-src-"));
  try {
    writeFileSync(join(srcDir, "main.sh"), "#!/bin/bash\necho hello");
    writeFileSync(join(srcDir, "jaiph_stdlib.sh"), "# stdlib");
    mkdirSync(join(srcDir, "runtime"));
    writeFileSync(join(srcDir, "runtime", "events.sh"), "# events");
    writeFileSync(join(srcDir, "runtime", "steps.sh"), "# steps");

    const genDir = prepareGeneratedDir(join(srcDir, "main.sh"), join(srcDir, "jaiph_stdlib.sh"));
    try {
      assert.ok(existsSync(join(genDir, "main.sh")));
      assert.ok(existsSync(join(genDir, "jaiph_stdlib.sh")));
      assert.ok(existsSync(join(genDir, "runtime", "events.sh")));
      assert.ok(existsSync(join(genDir, "runtime", "steps.sh")));
      assert.equal(readFileSync(join(genDir, "jaiph_stdlib.sh"), "utf8"), "# stdlib");
    } finally {
      rmSync(genDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildDockerArgs
// ---------------------------------------------------------------------------

test("buildDockerArgs: includes basic docker run flags", () => {
  const genDir = "/tmp/jaiph-gen";
  const opts: DockerSpawnOptions = {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      network: "default",
      timeout: 300,
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    },
    builtScriptPath: "/tmp/out/main.sh",
    stdlibPath: "/usr/lib/jaiph_stdlib.sh",
    workspaceRoot: "/home/user/project",
    wrapperCommand: 'echo "hello"',
    metaFile: "/tmp/out/.jaiph-run-meta.txt",
    workflowSymbol: "main",
    runArgs: ["arg1"],
    env: {},
    isTTY: false,
  };
  const args = buildDockerArgs(opts, genDir);

  assert.ok(args.includes("run"));
  assert.ok(args.includes("--rm"));
  assert.ok(!args.includes("-t")); // no TTY
  assert.ok(!args.includes("--network")); // "default" omits --network
  assert.ok(args.includes("ubuntu:24.04"));
  assert.ok(args.includes("-w"));
  assert.ok(args.includes("/jaiph/workspace"));

  // Generated dir mount
  const genMountIdx = args.indexOf(`${genDir}:/jaiph/generated:ro`);
  assert.ok(genMountIdx > 0);

  // JAIPH_STDLIB env
  const stdlibEnvIdx = args.indexOf("JAIPH_STDLIB=/jaiph/generated/jaiph_stdlib.sh");
  assert.ok(stdlibEnvIdx > 0);

  // Script path in command
  assert.ok(args.includes("/jaiph/generated/main.sh"));
  assert.ok(args.includes("arg1"));
});

test("buildDockerArgs: TTY flag when isTTY is true", () => {
  const opts: DockerSpawnOptions = {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      network: "default",
      timeout: 300,
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    },
    builtScriptPath: "/tmp/out/main.sh",
    stdlibPath: "/usr/lib/jaiph_stdlib.sh",
    workspaceRoot: "/home/user/project",
    wrapperCommand: 'echo "hello"',
    metaFile: "/tmp/out/.jaiph-run-meta.txt",
    workflowSymbol: "main",
    runArgs: [],
    env: {},
    isTTY: true,
  };
  const args = buildDockerArgs(opts, "/tmp/gen");
  assert.ok(args.includes("-t"));
});

test("buildDockerArgs: --network flag for non-default network", () => {
  const opts: DockerSpawnOptions = {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      network: "none",
      timeout: 300,
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    },
    builtScriptPath: "/tmp/out/main.sh",
    stdlibPath: "/usr/lib/jaiph_stdlib.sh",
    workspaceRoot: "/home/user/project",
    wrapperCommand: 'echo "hello"',
    metaFile: "/tmp/out/.jaiph-run-meta.txt",
    workflowSymbol: "main",
    runArgs: [],
    env: {},
    isTTY: false,
  };
  const args = buildDockerArgs(opts, "/tmp/gen");
  const netIdx = args.indexOf("--network");
  assert.ok(netIdx > 0);
  assert.equal(args[netIdx + 1], "none");
});

test("buildDockerArgs: forwards JAIPH_ env vars except JAIPH_STDLIB", () => {
  const opts: DockerSpawnOptions = {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      network: "default",
      timeout: 300,
      mounts: [{ hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" }],
    },
    builtScriptPath: "/tmp/out/main.sh",
    stdlibPath: "/usr/lib/jaiph_stdlib.sh",
    workspaceRoot: "/home/user/project",
    wrapperCommand: 'echo "hello"',
    metaFile: "/tmp/out/.jaiph-run-meta.txt",
    workflowSymbol: "main",
    runArgs: [],
    env: {
      JAIPH_DEBUG: "true",
      JAIPH_STDLIB: "/host/path/stdlib.sh",
      OTHER_VAR: "ignored",
    },
    isTTY: false,
  };
  const args = buildDockerArgs(opts, "/tmp/gen");
  // JAIPH_DEBUG should be forwarded
  assert.ok(args.includes("JAIPH_DEBUG=true"));
  // JAIPH_STDLIB should NOT be forwarded (overridden to container path)
  assert.ok(!args.includes("JAIPH_STDLIB=/host/path/stdlib.sh"));
  // Non-JAIPH vars should not be forwarded
  assert.ok(!args.some((a) => a.includes("OTHER_VAR")));
});

test("buildDockerArgs: multiple mounts produce multiple -v flags", () => {
  const opts: DockerSpawnOptions = {
    config: {
      enabled: true,
      image: "ubuntu:24.04",
      network: "default",
      timeout: 300,
      mounts: [
        { hostPath: ".", containerPath: "/jaiph/workspace", mode: "rw" },
        { hostPath: "config", containerPath: "/jaiph/workspace/config", mode: "ro" },
      ],
    },
    builtScriptPath: "/tmp/out/main.sh",
    stdlibPath: "/usr/lib/jaiph_stdlib.sh",
    workspaceRoot: "/home/user/project",
    wrapperCommand: 'echo "hello"',
    metaFile: "/tmp/out/.jaiph-run-meta.txt",
    workflowSymbol: "main",
    runArgs: [],
    env: {},
    isTTY: false,
  };
  const args = buildDockerArgs(opts, "/tmp/gen");
  const vFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
  // At least: generated dir + 2 user mounts + meta dir
  assert.ok(vFlags.length >= 4);
});
