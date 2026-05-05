import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";

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
