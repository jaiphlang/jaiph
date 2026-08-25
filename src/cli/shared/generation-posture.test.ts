import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGeneration, resolveStartupPosture, logStartupPosture, type GenerationState } from "./generation";

function makeGeneration(): { state: GenerationState; workspaceRoot: string; cleanup: () => void } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "jaiph-posture-ws-"));
  mkdirSync(join(workspaceRoot, ".jaiph"), { recursive: true });
  const inputAbs = join(workspaceRoot, "tools.jh");
  writeFileSync(inputAbs, ["# Greets.", "export def greet() {", '  return "hi"', "}", ""].join("\n"));
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-posture-tmp-"));
  const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, 0, {}, () => {}, "test");
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

test("startup posture: servers execute on the host", () => {
  const gen = makeGeneration();
  try {
    const posture = resolveStartupPosture(gen.state, gen.state.callEnv.inputAbs, gen.workspaceRoot, () => {});
    assert.ok(posture.hostRunsRoot.includes(".jaiph"), posture.hostRunsRoot);
    const lines: string[] = [];
    logStartupPosture("jaiph serve", "runs", posture, gen.workspaceRoot, (l) => lines.push(l));
    assert.deepEqual(lines, ["jaiph serve: runs execute on the host."]);
  } finally {
    gen.cleanup();
  }
});

test("loadGeneration threads the merged hook config into the call environment", () => {
  const gen = makeGeneration();
  try {
    assert.ok(gen.state.callEnv.hooks, "hooks config is loaded per generation");
    assert.deepEqual(gen.state.callEnv.hooks!.run_start, [], "empty workspace has no hook commands");
  } finally {
    gen.cleanup();
  }
});
