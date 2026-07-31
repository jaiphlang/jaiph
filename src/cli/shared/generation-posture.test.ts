import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGeneration, resolveStartupPosture, logStartupPosture, type GenerationState } from "./generation";
import type { SandboxFlags } from "../run/env";
import { _dockerExec } from "../../runtime/docker";

/**
 * `resolveStartupPosture` reads the server's process env; these tests pin the
 * flag → posture mapping, so the sandbox-control keys must not leak in from
 * the test runner env (`npm test` exports JAIPH_UNSAFE=true globally).
 */
const CONTROL_KEYS = ["JAIPH_UNSAFE", "JAIPH_INPLACE", "JAIPH_INPLACE_YES", "JAIPH_DOCKER_ENABLED"] as const;

function withCleanEnv<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of CONTROL_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = saved[key] ?? process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Stub every docker CLI call (info / inspect / verify) as succeeding. */
function withDockerStub<T>(fn: () => T): T {
  const orig = _dockerExec.run;
  _dockerExec.run = () => {};
  try {
    return fn();
  } finally {
    _dockerExec.run = orig;
  }
}

function makeGeneration(flags: SandboxFlags): { state: GenerationState; workspaceRoot: string; cleanup: () => void } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "jaiph-posture-ws-"));
  mkdirSync(join(workspaceRoot, ".jaiph"), { recursive: true });
  const inputAbs = join(workspaceRoot, "tools.jh");
  writeFileSync(inputAbs, ["# Greets.", "workflow greet() {", '  return "hi"', "}", ""].join("\n"));
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-posture-tmp-"));
  const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, 0, {}, () => {}, "test", flags);
  assert.ok(loaded.state, `fixture must validate: ${loaded.failures.join("; ")}`);
  return {
    state: loaded.state!,
    workspaceRoot,
    cleanup: () => {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function postureFor(flags: SandboxFlags, overrides: Record<string, string> = {}) {
  const gen = makeGeneration(flags);
  try {
    return withCleanEnv(overrides, () =>
      withDockerStub(() => {
        const posture = resolveStartupPosture(gen.state, gen.state.callEnv.inputAbs, gen.workspaceRoot, () => {});
        const lines: string[] = [];
        logStartupPosture("jaiph serve", "runs", posture, gen.workspaceRoot, (l) => lines.push(l));
        return { posture, lines, workspaceRoot: gen.workspaceRoot };
      }),
    );
  } finally {
    gen.cleanup();
  }
}

test("startup posture: --inplace keeps Docker on with the inplace sandbox mode, printed once", () => {
  const { posture, lines, workspaceRoot } = postureFor({ inplace: true });
  assert.equal(posture.dockerConfig.enabled, true);
  assert.equal(posture.sandboxMode, "inplace");
  assert.equal(posture.unsafeHostOnly, false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`in-place on ${workspaceRoot}`), lines[0]);
});

test("startup posture: env JAIPH_INPLACE=1 resolves identically to --inplace (env layer parity)", () => {
  const viaFlag = postureFor({ inplace: true });
  const viaEnv = postureFor({}, { JAIPH_INPLACE: "1" });
  assert.equal(viaEnv.posture.dockerConfig.enabled, viaFlag.posture.dockerConfig.enabled);
  assert.equal(viaEnv.posture.sandboxMode, viaFlag.posture.sandboxMode);
});

test("startup posture: --unsafe turns Docker off and emits the loud SANDBOXING DISABLED banner", () => {
  const { posture, lines } = postureFor({ unsafe: true });
  assert.equal(posture.dockerConfig.enabled, false);
  assert.equal(posture.unsafeHostOnly, true);
  const banner = lines.join("\n");
  assert.ok(banner.includes("UNSAFE MODE — SANDBOXING DISABLED"), banner);
  assert.ok(banner.includes("no sandbox"), banner);
  // The banner is a multi-line block, not a single suppressible log line.
  assert.ok(lines.length > 1, banner);
});

test("startup posture: --yes is explicit consent for an ambient JAIPH_UNSAFE=true (no refusal)", () => {
  const { posture, lines } = postureFor({ yes: true }, { JAIPH_UNSAFE: "true" });
  assert.equal(posture.unsafeHostOnly, true);
  assert.ok(lines.join("\n").includes("SANDBOXING DISABLED"), lines.join("\n"));
});

test("startup posture: an inherited JAIPH_UNSAFE=true without an explicit flag is refused (finding M-1)", () => {
  const gen = makeGeneration({});
  try {
    withCleanEnv({ JAIPH_UNSAFE: "true" }, () =>
      withDockerStub(() => {
        assert.throws(
          () => resolveStartupPosture(gen.state, gen.state.callEnv.inputAbs, gen.workspaceRoot, () => {}),
          /E_UNSAFE_NO_CONSENT/,
        );
      }),
    );
  } finally {
    gen.cleanup();
  }
});

test("startup posture: Docker off by explicit config is not the unsafe opt-in", () => {
  const { posture, lines } = postureFor({}, { JAIPH_DOCKER_ENABLED: "false" });
  assert.equal(posture.dockerConfig.enabled, false);
  assert.equal(posture.unsafeHostOnly, false);
  assert.equal(lines[0], "jaiph serve: runs execute on the host with no sandbox.");
});

test("startup posture: default (no flags, no env) is the isolated Docker snapshot", () => {
  const { posture, lines } = postureFor({});
  assert.equal(posture.dockerConfig.enabled, true);
  assert.equal(posture.sandboxMode, "snapshot");
  assert.ok(lines[0].includes("snapshot mode; workspace isolated"), lines[0]);
});

test("startup posture: --inplace + JAIPH_UNSAFE=true conflict fails before anything spawns", () => {
  const gen = makeGeneration({ inplace: true });
  try {
    withCleanEnv({ JAIPH_UNSAFE: "true" }, () =>
      withDockerStub(() => {
        assert.throws(
          () => resolveStartupPosture(gen.state, gen.state.callEnv.inputAbs, gen.workspaceRoot, () => {}),
          /E_FLAG_CONFLICT/,
        );
      }),
    );
  } finally {
    gen.cleanup();
  }
});

test("loadGeneration threads sandbox flags and the merged hook config into the call environment", () => {
  const gen = makeGeneration({ unsafe: true, yes: true });
  try {
    assert.deepEqual(gen.state.callEnv.sandboxFlags, { unsafe: true, yes: true });
    assert.ok(gen.state.callEnv.hooks, "hooks config is loaded per generation");
    assert.deepEqual(gen.state.callEnv.hooks!.workflow_start, [], "empty workspace has no hook commands");
  } finally {
    gen.cleanup();
  }
});
