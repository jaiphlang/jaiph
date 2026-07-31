import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  appendRunSummaryLine,
  CHAIN_GENESIS,
  CHAIN_KEY_ENV,
  formatUtcTimestamp,
  readChainKey,
  verifyRunJournal,
  verifyRunSummaryChain,
  writeChainKey,
} from "./emit";
import { RuntimeEventEmitter } from "./runtime-event-emitter";

const TEST_KEY = "a".repeat(64);

describe("emit kernel", () => {
  it("formatUtcTimestamp matches no-millis Z suffix", () => {
    const s = formatUtcTimestamp();
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!s.includes("."));
  });

  it("appendRunSummaryLine writes under JAIPH_RUN_SUMMARY_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      process.env.JAIPH_RUN_SUMMARY_FILE = summary;
      appendRunSummaryLine('{"type":"X","event_version":1}');
      const text = readFileSync(summary, "utf8");
      assert.equal(text.trim(), '{"type":"X","event_version":1}');
    } finally {
      delete process.env.JAIPH_RUN_SUMMARY_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run_summary.jsonl keyed hash chain", () => {
  function makeEmitter(runDir: string, env?: NodeJS.ProcessEnv): RuntimeEventEmitter {
    return new RuntimeEventEmitter({
      runId: "test-chain-run",
      runDir,
      env: env ?? process.env,
      getFrameStack: () => [],
      getAsyncIndices: () => [],
      suppressLiveEvents: true,
    });
  }

  /** Run `fn` with a summary file + the chain key both set, restoring env after. */
  function withRun(prefix: string, fn: (dir: string, summary: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const summary = join(dir, "run_summary.jsonl");
    const prevSummary = process.env.JAIPH_RUN_SUMMARY_FILE;
    const prevKey = process.env[CHAIN_KEY_ENV];
    try {
      process.env.JAIPH_RUN_SUMMARY_FILE = summary;
      process.env[CHAIN_KEY_ENV] = TEST_KEY;
      fn(dir, summary);
    } finally {
      if (prevSummary === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummary;
      if (prevKey === undefined) delete process.env[CHAIN_KEY_ENV];
      else process.env[CHAIN_KEY_ENV] = prevKey;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("untampered chain verifies successfully under the key", () => {
    withRun("jaiph-chain-ok-", (_dir, summary) => {
      const emitter = makeEmitter(_dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      emitter.emitLog("LOG", "hello");
      const result = verifyRunSummaryChain(summary, TEST_KEY);
      assert.equal(result.ok, true, result.error);
    });
  });

  it("tampered first line breaks the chain", () => {
    withRun("jaiph-chain-tamper-", (_dir, summary) => {
      const emitter = makeEmitter(_dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      emitter.emitLog("LOG", "hello");

      const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      first["workflow"] = "tampered";
      writeFileSync(summary, [JSON.stringify(first), ...lines.slice(1)].join("\n") + "\n");

      const result = verifyRunSummaryChain(summary, TEST_KEY);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes("line 2"), `expected broken link at line 2, got: ${result.error}`);
    });
  });

  // AC4: a chain recomputed with the *public* SHA-256 algorithm (no key), the
  // exact H-3 forgery, is rejected — its very first prev_hash fails to match
  // the keyed genesis. This is the pre-fix "internally valid" rewrite.
  it("rejects a recomputed-but-forged SHA-256 chain (no key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-chain-forged-"));
    const summary = join(dir, "run_summary.jsonl");
    try {
      const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
      // Attacker's rewrite: omit an incriminating line, chain the rest with the
      // public genesis + SHA-256 exactly as the old unkeyed emitter did.
      const l0 = JSON.stringify({ type: "WORKFLOW_START", workflow: "clean", prev_hash: CHAIN_GENESIS });
      const l1 = JSON.stringify({ type: "WORKFLOW_END", workflow: "clean", prev_hash: sha(l0) });
      writeFileSync(summary, `${l0}\n${l1}\n`);

      const result = verifyRunSummaryChain(summary, TEST_KEY);
      assert.equal(result.ok, false, "a forged unkeyed chain must not verify under the key");
      assert.ok(result.error?.includes("line 1"), `forgery caught at the genesis link, got: ${result.error}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A deleted / truncated journal is a verification failure, not a silent pass.
  it("rejects a missing journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-chain-missing-"));
    try {
      const result = verifyRunSummaryChain(join(dir, "run_summary.jsonl"), TEST_KEY);
      assert.equal(result.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifyRunJournal skips (verified:false) when no key file is present", () => {
    withRun("jaiph-chain-nokey-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      // No writeChainKey → boundaries cannot verify and must not block.
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, false);
      assert.equal(res.ok, true);
      assert.equal(readChainKey(dir), null);
      assert.ok(summary);
    });
  });

  it("verifyRunJournal hard-fails once the key file is written and an incriminating line is dropped", () => {
    withRun("jaiph-chain-boundary-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      emitter.emitLog("LOGERR", "incriminating failure");
      emitter.emitWorkflow("WORKFLOW_END", "default");
      // Host persists the key after the run (as run.ts / call.ts do at finalize).
      writeChainKey(dir, TEST_KEY);
      assert.equal(verifyRunJournal(dir).ok, true, "untampered journal verifies once keyed");

      // Attacker drops the middle (incriminating) line and keeps the rest — the
      // classic "omit a line" rewrite. Without the key the surviving tail's
      // prev_hash no longer matches the recomputed chain, so it is detected.
      const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      writeFileSync(summary, [lines[0], lines[2]].join("\n") + "\n");
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true);
      assert.equal(res.ok, false, "dropping a middle line breaks the keyed chain");
    });
  });
});
