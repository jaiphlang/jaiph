import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  appendRunSummaryLine,
  CHAIN_GENESIS,
  CHAIN_KEY_ENV,
  chainKeyPath,
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

  /**
   * Run `fn` with a summary file, the chain key, and an isolated operator-side
   * key store (`JAIPH_AUDIT_KEY_DIR`) all set, restoring env after. The store is
   * a fresh temp dir OUTSIDE the run dir so tests never touch the real home store
   * and each case starts from an empty store.
   */
  function withRun(prefix: string, fn: (dir: string, summary: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = mkdtempSync(join(tmpdir(), `${prefix}store-`));
    const summary = join(dir, "run_summary.jsonl");
    const prevSummary = process.env.JAIPH_RUN_SUMMARY_FILE;
    const prevKey = process.env[CHAIN_KEY_ENV];
    const prevStore = process.env.JAIPH_AUDIT_KEY_DIR;
    try {
      process.env.JAIPH_RUN_SUMMARY_FILE = summary;
      process.env[CHAIN_KEY_ENV] = TEST_KEY;
      process.env.JAIPH_AUDIT_KEY_DIR = store;
      fn(dir, summary);
    } finally {
      if (prevSummary === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummary;
      if (prevKey === undefined) delete process.env[CHAIN_KEY_ENV];
      else process.env[CHAIN_KEY_ENV] = prevKey;
      if (prevStore === undefined) delete process.env.JAIPH_AUDIT_KEY_DIR;
      else process.env.JAIPH_AUDIT_KEY_DIR = prevStore;
      rmSync(dir, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  }

  it("untampered chain verifies successfully under the key", () => {
    withRun("jaiph-chain-ok-", (_dir, summary) => {
      const emitter = makeEmitter(_dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOG", "hello");
      const result = verifyRunSummaryChain(summary, TEST_KEY);
      assert.equal(result.ok, true, result.error);
    });
  });

  it("tampered first line breaks the chain", () => {
    withRun("jaiph-chain-tamper-", (_dir, summary) => {
      const emitter = makeEmitter(_dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOG", "hello");

      const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      first["def"] = "tampered";
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
      const l0 = JSON.stringify({ type: "RUN_START", def: "clean", prev_hash: CHAIN_GENESIS });
      const l1 = JSON.stringify({ type: "RUN_END", def: "clean", prev_hash: sha(l0) });
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

  it("verifyRunJournal skips (verified:false) when the run was never keyed", () => {
    withRun("jaiph-chain-nokey-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      // No writeChainKey → no store entry → boundaries cannot verify, must not block.
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, false);
      assert.equal(res.ok, true);
      assert.equal(readChainKey(dir), null);
      assert.ok(summary);
    });
  });

  // AC1: the key is persisted OUTSIDE the (agent-writable) run directory. The
  // run dir holds no `.chain-key`; the key lives in the operator-side store.
  it("persists the key outside the run dir, never as .chain-key inside it", () => {
    withRun("jaiph-chain-outside-", (dir, _summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);

      assert.ok(!existsSync(join(dir, ".chain-key")), "run dir must not contain a .chain-key file");
      assert.ok(
        !readdirSync(dir).some((n) => n.includes("chain-key")),
        "run dir must hold no chain-key artifact at all",
      );
      const keyFile = chainKeyPath(dir);
      assert.ok(!keyFile.startsWith(dir), "the key store must live outside the run dir");
      assert.ok(existsSync(keyFile), "the key exists in the host-side store");
      assert.equal(readFileSync(keyFile, "utf8"), TEST_KEY);
      assert.equal(verifyRunJournal(dir).ok, true, "the untampered journal verifies from the outside store");
    });
  });

  // AC2 (squat): a workflow's first script step pre-creates a directory at the
  // OLD in-run-dir key path (`mkdir "$JAIPH_RUN_DIR/.chain-key"`). Because the
  // key no longer lives there, persistence and verification are unaffected.
  it("is unaffected by a squatted .chain-key directory in the run dir", () => {
    withRun("jaiph-chain-squat-", (dir, summary) => {
      // The squat: the old key path is now an agent-created directory.
      mkdirSync(join(dir, ".chain-key"), { recursive: true });

      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOGERR", "incriminating failure");
      emitter.emitRun("RUN_END", "main");
      // The host persists the key despite the squat — it writes to the store, not the run dir.
      writeChainKey(dir, TEST_KEY);
      assert.ok(existsSync(chainKeyPath(dir)), "key persisted to the store despite the squat");
      assert.equal(verifyRunJournal(dir).ok, true, "untampered journal still verifies");

      // And the tamper is still caught: drop the middle (incriminating) line.
      const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      writeFileSync(summary, [lines[0], lines[2]].join("\n") + "\n");
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true);
      assert.equal(res.ok, false, "dropping a line is still detected under the squat");
    });
  });

  // AC3: a failure to persist the key is a HARD error, not best-effort.
  it("writeChainKey throws when the store cannot be written", () => {
    withRun("jaiph-chain-hard-", (dir, _summary) => {
      // Force the write to fail: point the store at a regular FILE so mkdir of
      // any entry under it raises ENOTDIR/EEXIST instead of silently succeeding.
      const storeFile = mkdtempSync(join(tmpdir(), "jaiph-chain-hardfile-"));
      const blocker = join(storeFile, "not-a-dir");
      writeFileSync(blocker, "x");
      process.env.JAIPH_AUDIT_KEY_DIR = blocker;
      assert.throws(() => writeChainKey(dir, TEST_KEY), "persist failure must surface as a hard error");
      rmSync(storeFile, { recursive: true, force: true });
    });
  });

  // AC4: a run launched WITH a key whose key is missing at verify time is a
  // fail-closed integrity failure — not a silent "not verified" pass. Every
  // export boundary keys off `verified && !ok`, so this blocks OTLP/Sentry/serve.
  it("verifyRunJournal fails closed when a keyed run's key is missing", () => {
    withRun("jaiph-chain-failclosed-", (dir, _summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);
      assert.equal(verifyRunJournal(dir).ok, true, "verifies while the key is present");

      // Simulate the key vanishing after the run was keyed (the marker survives).
      rmSync(chainKeyPath(dir), { force: true });
      assert.equal(readChainKey(dir), null, "the key is gone");
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true, "the run was keyed, so it must be verified — not skipped");
      assert.equal(res.ok, false, "a missing key on a keyed run fails closed");
    });
  });

  // L-3 AC2 (happy path): a complete terminal journal — ending with the
  // RUN_END marker — verifies successfully at the boundary and under the
  // low-level chain check with requireTerminal.
  it("a complete terminal journal (ends with RUN_END) verifies", () => {
    withRun("jaiph-chain-terminal-ok-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOG", "hello");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);

      assert.equal(verifyRunSummaryChain(summary, TEST_KEY, { requireTerminal: true }).ok, true);
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true);
      assert.equal(res.ok, true, res.error);
    });
  });

  // L-3 AC1 (truncation rejected): deleting the last K lines of a completed
  // terminal journal leaves a shorter-but-internally-valid chain. The prefix
  // still links (so the plain chain check passes), but the terminal marker is
  // gone, so the boundary — and requireTerminal — reject it.
  it("rejects a terminal journal whose tail was truncated after the run ended", () => {
    withRun("jaiph-chain-truncate-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOGERR", "incriminating failure");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);
      assert.equal(verifyRunJournal(dir).ok, true, "the intact terminal journal verifies first");

      // Post-terminal tail truncation: drop the last two lines (the incriminating
      // LOGERR and the RUN_END), leaving only the RUN_START prefix.
      const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      writeFileSync(summary, lines.slice(0, 1).join("\n") + "\n");

      // The surviving prefix still chains correctly — the pre-fix hole.
      assert.equal(
        verifyRunSummaryChain(summary, TEST_KEY).ok,
        true,
        "the truncated prefix is still internally chain-valid (the L-3 gap)",
      );
      // But requiring terminality rejects it: the RUN_END marker is gone.
      const chain = verifyRunSummaryChain(summary, TEST_KEY, { requireTerminal: true });
      assert.equal(chain.ok, false);
      assert.ok(chain.error?.includes("not terminal"), `expected a terminality failure, got: ${chain.error}`);
      // And the boundary hard-fails.
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true);
      assert.equal(res.ok, false, "a truncated-but-valid prefix must fail at the boundary");
    });
  });

  // L-3 AC1 (fully truncated): clean-truncating the whole journal to empty is
  // also rejected — there is no terminal marker (and the empty run dir is a
  // keyed-but-empty tamper, not a legacy unkeyed run).
  it("rejects a keyed journal truncated to empty", () => {
    withRun("jaiph-chain-empty-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);
      writeFileSync(summary, "");
      const res = verifyRunJournal(dir);
      assert.equal(res.verified, true);
      assert.equal(res.ok, false, "an emptied keyed journal has no terminal marker and must fail");
    });
  });

  // L-3 AC3 (during-run append regression): an append that breaks the chain — a
  // forged line whose prev_hash does not match the running head — is still
  // caught by the chain walk, independent of the new terminality check. This
  // covers the "later kernel appends break the chain" mid-run detection.
  it("still rejects an append that breaks the chain", () => {
    withRun("jaiph-chain-append-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitRun("RUN_END", "main");
      writeChainKey(dir, TEST_KEY);

      // Append a RUN_END-typed line with a bogus prev_hash (a tamper that
      // keeps a terminal marker last but breaks the link). The chain walk must
      // still reject it before terminality is even considered.
      const forged = JSON.stringify({ type: "RUN_END", def: "forged", prev_hash: "deadbeef" });
      writeFileSync(summary, readFileSync(summary, "utf8") + forged + "\n");

      const chain = verifyRunSummaryChain(summary, TEST_KEY, { requireTerminal: true });
      assert.equal(chain.ok, false);
      assert.ok(chain.error?.includes("prev_hash"), `expected a broken-link failure, got: ${chain.error}`);
      assert.equal(verifyRunJournal(dir).ok, false);
    });
  });

  it("verifyRunJournal hard-fails once the key file is written and an incriminating line is dropped", () => {
    withRun("jaiph-chain-boundary-", (dir, summary) => {
      const emitter = makeEmitter(dir);
      emitter.emitRun("RUN_START", "main");
      emitter.emitLog("LOGERR", "incriminating failure");
      emitter.emitRun("RUN_END", "main");
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
