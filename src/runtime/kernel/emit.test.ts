import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";

const emitJs = join(__dirname, "emit.js");

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
      delete process.env.JAIPH_INBOX_PARALLEL;
      appendRunSummaryLine('{"type":"X","event_version":1}');
      const text = readFileSync(summary, "utf8");
      assert.equal(text.trim(), '{"type":"X","event_version":1}');
    } finally {
      delete process.env.JAIPH_RUN_SUMMARY_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live mode writes __JAIPH_EVENT__ and LOG summary line", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-live-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const payload = '{"type":"LOG","message":"hi","depth":1}';
      const r = spawnSync(process.execPath, [emitJs, "live"], {
        input: `${payload}\n`,
        env: {
          ...process.env,
          JAIPH_RUN_SUMMARY_FILE: summary,
          JAIPH_RUN_ID: "run-z",
          JAIPH_EVENT_FD: "2",
        },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok((r.stderr ?? "").includes("__JAIPH_EVENT__"));
      assert.ok((r.stderr ?? "").includes('"type":"LOG"'));
      const lines = readFileSync(summary, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const row = JSON.parse(lines[0]!) as Record<string, unknown>;
      assert.equal(row.type, "LOG");
      assert.equal(row.message, "hi");
      assert.equal(row.depth, 1);
      assert.equal(row.run_id, "run-z");
      assert.equal(row.event_version, 1);
      assert.equal(typeof row.ts, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summary-line mode appends caller-built JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-sum-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const line = '{"type":"WORKFLOW_START","workflow":"w","source":"f.jh","ts":"2020-01-01T00:00:00Z","run_id":"r","event_version":1}';
      const r = spawnSync(process.execPath, [emitJs, "summary-line"], {
        input: `${line}\n`,
        env: { ...process.env, JAIPH_RUN_SUMMARY_FILE: summary },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(summary, "utf8").trim(), line);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live STEP_END persists event_version without re-emitting to stderr twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-step-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const payload =
        '{"type":"STEP_END","func":"f","kind":"step","name":"n","ts":"2020-01-01T00:00:01Z","status":0,"elapsed_ms":1,"out_file":"","err_file":"","id":"sid","parent_id":null,"seq":1,"depth":0,"run_id":"r"}';
      const r = spawnSync(process.execPath, [emitJs, "live"], {
        input: `${payload}\n`,
        env: {
          ...process.env,
          JAIPH_RUN_SUMMARY_FILE: summary,
          JAIPH_EVENT_FD: "2",
        },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const errLines = (r.stderr ?? "").split("\n").filter(Boolean);
      assert.equal(errLines.filter((l) => l.startsWith("__JAIPH_EVENT__")).length, 1);
      const sum = JSON.parse(readFileSync(summary, "utf8").trim()) as Record<string, unknown>;
      assert.equal(sum.event_version, 1);
      assert.equal(sum.type, "STEP_END");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("step-event mode builds STEP_START JSON from args", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-se-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const r = spawnSync(
        process.execPath,
        [emitJs, "step-event", "STEP_START", "mod::fn", "workflow", "", "", "", "", "sid", "pid", "1", "0", "key1=val1"],
        {
          env: {
            ...process.env,
            JAIPH_RUN_SUMMARY_FILE: summary,
            JAIPH_RUN_ID: "run-t",
            JAIPH_EVENT_FD: "2",
            JAIPH_STEP_PARAM_KEYS: "key1",
          },
          encoding: "utf8",
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok((r.stderr ?? "").includes("__JAIPH_EVENT__"));
      const sum = JSON.parse(readFileSync(summary, "utf8").trim()) as Record<string, unknown>;
      assert.equal(sum.type, "STEP_START");
      assert.equal(sum.func, "mod::fn");
      assert.equal(sum.kind, "workflow");
      assert.equal(sum.name, "fn");
      assert.equal(sum.run_id, "run-t");
      assert.equal(sum.event_version, 1);
      assert.deepEqual(sum.params, [["key1", "val1"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("step-event STEP_END embeds out_content from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-end-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const outFile = join(dir, "step.out");
      writeFileSync(outFile, "hello output");
      const r = spawnSync(
        process.execPath,
        [emitJs, "step-event", "STEP_END", "mod::fn", "script", "0", "100", outFile, "", "sid", "", "1", "0"],
        {
          env: {
            ...process.env,
            JAIPH_RUN_SUMMARY_FILE: summary,
            JAIPH_RUN_ID: "run-t",
            JAIPH_EVENT_FD: "2",
          },
          encoding: "utf8",
        },
      );
      assert.equal(r.status, 0, r.stderr);
      const sum = JSON.parse(readFileSync(summary, "utf8").trim()) as Record<string, unknown>;
      assert.equal(sum.type, "STEP_END");
      assert.equal(sum.status, 0);
      assert.equal(sum.elapsed_ms, 100);
      assert.equal(sum.out_content, "hello output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("log mode builds LOG JSON with depth from JAIPH_STEP_STACK", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-log-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const r = spawnSync(process.execPath, [emitJs, "log", "hello world"], {
        env: {
          ...process.env,
          JAIPH_RUN_SUMMARY_FILE: summary,
          JAIPH_RUN_ID: "run-l",
          JAIPH_EVENT_FD: "2",
          JAIPH_STEP_STACK: "a,b",
        },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok((r.stderr ?? "").includes("__JAIPH_EVENT__"));
      assert.ok((r.stderr ?? "").includes('"depth":2'));
      const sum = JSON.parse(readFileSync(summary, "utf8").trim()) as Record<string, unknown>;
      assert.equal(sum.type, "LOG");
      assert.equal(sum.message, "hello world");
      assert.equal(sum.depth, 2);
      assert.equal(sum.run_id, "run-l");
      assert.equal(sum.event_version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workflow-event mode builds summary-only WORKFLOW_START", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaiph-emit-wf-"));
    try {
      const summary = join(dir, "run_summary.jsonl");
      const r = spawnSync(process.execPath, [emitJs, "workflow-event", "WORKFLOW_START", "default"], {
        env: {
          ...process.env,
          JAIPH_RUN_SUMMARY_FILE: summary,
          JAIPH_RUN_ID: "run-w",
          JAIPH_SOURCE_FILE: "main.jh",
        },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const sum = JSON.parse(readFileSync(summary, "utf8").trim()) as Record<string, unknown>;
      assert.equal(sum.type, "WORKFLOW_START");
      assert.equal(sum.workflow, "default");
      assert.equal(sum.source, "main.jh");
      assert.equal(sum.run_id, "run-w");
      assert.equal(sum.event_version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
