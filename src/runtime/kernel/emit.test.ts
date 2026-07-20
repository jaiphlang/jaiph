import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendRunSummaryLine, formatUtcTimestamp, verifyRunSummaryChain } from "./emit";
import { RuntimeEventEmitter } from "./runtime-event-emitter";

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

describe("run_summary.jsonl hash chain", () => {
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

  it("untampered chain verifies successfully", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-chain-ok-"));
    const summary = join(dir, "run_summary.jsonl");
    const prev = process.env.JAIPH_RUN_SUMMARY_FILE;
    try {
      process.env.JAIPH_RUN_SUMMARY_FILE = summary;
      const emitter = makeEmitter(dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      emitter.emitLog("LOG", "hello");
      const result = verifyRunSummaryChain(summary);
      assert.equal(result.ok, true, result.error);
    } finally {
      if (prev === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tampered first line breaks the chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-chain-tamper-"));
    const summary = join(dir, "run_summary.jsonl");
    const prev = process.env.JAIPH_RUN_SUMMARY_FILE;
    try {
      process.env.JAIPH_RUN_SUMMARY_FILE = summary;
      const emitter = makeEmitter(dir);
      emitter.emitWorkflow("WORKFLOW_START", "default");
      emitter.emitLog("LOG", "hello");

      const text = readFileSync(summary, "utf8");
      const lines = text.split("\n").filter(Boolean);
      // Tamper: change the workflow name on the first line.
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      first["workflow"] = "tampered";
      const tamperedText = [JSON.stringify(first), ...lines.slice(1)].join("\n") + "\n";
      writeFileSync(summary, tamperedText);

      const result = verifyRunSummaryChain(summary);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes("line 2"), `expected broken link at line 2, got: ${result.error}`);
    } finally {
      if (prev === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
      else process.env.JAIPH_RUN_SUMMARY_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
