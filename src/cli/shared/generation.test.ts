import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerationTracker, type GenerationState } from "./generation";

/**
 * The tracker only reads `state.callEnv.outDir` (the directory it deletes), so
 * the tests stub the rest of the generation state.
 */
function makeState(tempRoot: string, generation: number): GenerationState {
  const outDir = join(tempRoot, `gen-${generation}`);
  mkdirSync(outDir, { recursive: true });
  return { callEnv: { outDir } } as GenerationState;
}

test("generation tracker: swap with no in-flight leases deletes the previous dir immediately", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-gen-test-"));
  try {
    const gen0 = makeState(tempRoot, 0);
    const gen1 = makeState(tempRoot, 1);
    const tracker = createGenerationTracker(gen0);
    assert.equal(tracker.current(), gen0);

    tracker.swap(gen1);
    assert.equal(tracker.current(), gen1);
    assert.equal(existsSync(gen0.callEnv.outDir), false, "idle superseded dir is deleted on swap");
    assert.equal(existsSync(gen1.callEnv.outDir), true, "current dir survives");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("generation tracker: a lease keeps the superseded dir alive until it is released", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-gen-test-"));
  try {
    const gen0 = makeState(tempRoot, 0);
    const gen1 = makeState(tempRoot, 1);
    const tracker = createGenerationTracker(gen0);

    const lease = tracker.acquire();
    assert.equal(lease.state, gen0, "the lease pins the generation live at call start");

    tracker.swap(gen1);
    assert.equal(existsSync(gen0.callEnv.outDir), true, "superseded dir survives while the call runs");
    assert.equal(tracker.current(), gen1, "new calls bind to the new generation");

    lease.release();
    assert.equal(existsSync(gen0.callEnv.outDir), false, "last release deletes the superseded dir");
    assert.equal(existsSync(gen1.callEnv.outDir), true, "current dir is never deleted");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("generation tracker: concurrent leases across multiple swaps settle independently", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-gen-test-"));
  try {
    const gen0 = makeState(tempRoot, 0);
    const gen1 = makeState(tempRoot, 1);
    const gen2 = makeState(tempRoot, 2);
    const tracker = createGenerationTracker(gen0);

    const leaseA = tracker.acquire(); // gen0
    tracker.swap(gen1);
    const leaseB = tracker.acquire(); // gen1
    tracker.swap(gen2);

    assert.equal(leaseA.state, gen0);
    assert.equal(leaseB.state, gen1);
    assert.equal(existsSync(gen0.callEnv.outDir), true, "gen0 pinned by lease A");
    assert.equal(existsSync(gen1.callEnv.outDir), true, "gen1 pinned by lease B");

    // Out-of-order settle: the newer call finishes first.
    leaseB.release();
    assert.equal(existsSync(gen1.callEnv.outDir), false, "gen1 deleted when its last call settles");
    assert.equal(existsSync(gen0.callEnv.outDir), true, "gen0 still pinned");

    leaseA.release();
    assert.equal(existsSync(gen0.callEnv.outDir), false, "gen0 deleted when its last call settles");
    assert.equal(existsSync(gen2.callEnv.outDir), true, "only the current generation dir remains");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("generation tracker: release is idempotent and cannot free a dir another lease still holds", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-gen-test-"));
  try {
    const gen0 = makeState(tempRoot, 0);
    const gen1 = makeState(tempRoot, 1);
    const tracker = createGenerationTracker(gen0);

    const leaseA = tracker.acquire();
    const leaseB = tracker.acquire();
    tracker.swap(gen1);

    leaseA.release();
    leaseA.release(); // double release must not decrement past its own lease
    assert.equal(existsSync(gen0.callEnv.outDir), true, "lease B still holds the dir");

    leaseB.release();
    assert.equal(existsSync(gen0.callEnv.outDir), false, "deleted once the true last lease settles");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
