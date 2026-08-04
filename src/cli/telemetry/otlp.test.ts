import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  runSummaryToOtlp,
  resolveOtlpEndpoint,
  parseKeyValueList,
  resolveFlushBudgetMs,
  exportRunTelemetry,
  exportOtlpTraces,
  deliverRunTelemetryDetached,
  telemetryDeliveryMetrics,
  type OtlpMeta,
} from "./otlp";
import { writeChainKey } from "../../runtime";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

/** Mirror of the module's span-id derivation, for asserting parent links. */
function spanIdFor(eventId: string): string {
  return createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 16);
}

function nano(ts: string): string {
  return (BigInt(Date.parse(ts)) * 1_000_000n).toString();
}

const T = {
  wfStart: "2026-04-21T16:02:00Z",
  fibStart: "2026-04-21T16:02:01Z",
  fibEnd: "2026-04-21T16:02:02Z",
  promptStart: "2026-04-21T16:02:03Z",
  promptEnd: "2026-04-21T16:02:05Z",
  boomStart: "2026-04-21T16:02:06Z",
  boomEnd: "2026-04-21T16:02:07Z",
  hangStart: "2026-04-21T16:02:08Z",
  log: "2026-04-21T16:02:09Z",
  wfEnd: "2026-04-21T16:02:10Z",
};

/** A journal covering the root, a script step, a prompt, a failed step, and a crash. */
function fixtureLines(): string[] {
  const runId = RUN_ID;
  const events: Record<string, unknown>[] = [
    { type: "WORKFLOW_START", workflow: "default", source: "fib.jh", ts: T.wfStart, run_id: runId },
    { type: "STEP_START", func: "default", kind: "workflow", name: "default", ts: T.wfStart, id: "R:1", parent_id: null, seq: 1, depth: 0, run_id: runId },
    { type: "STEP_START", func: "fib", kind: "script", name: "fib", ts: T.fibStart, id: "R:2", parent_id: "R:1", seq: 2, depth: 1, run_id: runId },
    { type: "STEP_END", func: "fib", kind: "script", name: "fib", ts: T.fibEnd, status: 0, elapsed_ms: 100, id: "R:2", parent_id: "R:1", seq: 2, depth: 1, run_id: runId, out_content: "ok\n", err_content: "" },
    { type: "STEP_START", func: "prompt", kind: "prompt", name: "claude", ts: T.promptStart, id: "R:p1", parent_id: "R:1", seq: 3, depth: 1, run_id: runId },
    { type: "PROMPT_START", ts: T.promptStart, run_id: runId, step_id: "R:p1", backend: "claude", model: "sonnet", status: null },
    { type: "PROMPT_END", ts: T.promptEnd, run_id: runId, step_id: "R:p1", backend: "claude", model: "sonnet", status: 0 },
    { type: "STEP_END", func: "prompt", kind: "prompt", name: "claude", ts: T.promptEnd, status: 0, elapsed_ms: 2000, id: "R:p1", parent_id: "R:1", seq: 3, depth: 1, run_id: runId, out_content: "", err_content: "" },
    { type: "STEP_START", func: "boom", kind: "script", name: "boom", ts: T.boomStart, id: "R:3", parent_id: "R:1", seq: 4, depth: 1, run_id: runId },
    { type: "STEP_END", func: "boom", kind: "script", name: "boom", ts: T.boomEnd, status: 1, elapsed_ms: 5, id: "R:3", parent_id: "R:1", seq: 4, depth: 1, run_id: runId, out_content: "", err_content: "bad\n" },
    { type: "STEP_START", func: "hang", kind: "script", name: "hang", ts: T.hangStart, id: "R:4", parent_id: "R:1", seq: 5, depth: 1, run_id: runId },
    { type: "LOGERR", message: "warn-line", depth: 1, ts: T.log, run_id: runId },
    { type: "WORKFLOW_END", workflow: "default", source: "fib.jh", ts: T.wfEnd, run_id: runId },
  ];
  return events.map((e) => JSON.stringify(e));
}

const META: OtlpMeta = {
  workflow: "default",
  exitStatus: 1,
  signal: null,
  serviceName: "jaiph",
  resourceAttributes: { "jaiph.version": "9.9.9", "deployment.environment": "ci" },
};

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  events?: Array<{ timeUnixNano: string; name: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>;
}

function spansOf(payload: Record<string, unknown>): Span[] {
  const rs = (payload.resourceSpans as Array<Record<string, unknown>>)[0];
  const ss = (rs.scopeSpans as Array<Record<string, unknown>>)[0];
  return ss.spans as unknown as Span[];
}

function attrString(span: Span, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value.stringValue;
}
function attrInt(span: Span, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value.intValue;
}

test("runSummaryToOtlp: trace id is the run id UUID with dashes stripped", () => {
  const spans = spansOf(runSummaryToOtlp(fixtureLines(), META));
  for (const s of spans) {
    assert.equal(s.traceId, "11111111222233334444555555555555");
    assert.equal(s.traceId.length, 32);
  }
});

test("runSummaryToOtlp: root span carries workflow name and OK/ERROR from run exit", () => {
  const root = spansOf(runSummaryToOtlp(fixtureLines(), META)).find((s) => s.name === "workflow default")!;
  assert.ok(root, "root span present");
  assert.equal(root.parentSpanId, undefined, "root has no parent");
  assert.equal(root.spanId, spanIdFor(RUN_ID));
  assert.equal(root.startTimeUnixNano, nano(T.wfStart));
  assert.equal(root.endTimeUnixNano, nano(T.wfEnd));
  // nonzero run exit → root status 2
  assert.equal(root.status.code, 2);

  const ok = spansOf(runSummaryToOtlp(fixtureLines(), { ...META, exitStatus: 0 })).find((s) => s.name === "workflow default")!;
  assert.equal(ok.status.code, 1);

  const sig = spansOf(runSummaryToOtlp(fixtureLines(), { ...META, exitStatus: 0, signal: "SIGKILL" })).find((s) => s.name === "workflow default")!;
  assert.equal(sig.status.code, 2, "a terminating signal marks the root ERROR even at exit 0");
});

test("runSummaryToOtlp: step span parented per parent_id (root when null)", () => {
  const spans = spansOf(runSummaryToOtlp(fixtureLines(), META));
  const rootStep = spans.find((s) => s.spanId === spanIdFor("R:1"))!;
  assert.equal(rootStep.parentSpanId, spanIdFor(RUN_ID), "parent_id null → parented to the run root span");
  const fib = spans.find((s) => s.spanId === spanIdFor("R:2"))!;
  assert.equal(fib.parentSpanId, spanIdFor("R:1"), "fib parented to the workflow step via parent_id");
  assert.equal(fib.name, "script fib");
  assert.equal(attrString(fib, "jaiph.step.kind"), "script");
  assert.equal(attrString(fib, "jaiph.step.func"), "fib");
  assert.equal(attrString(fib, "jaiph.step.name"), "fib");
  assert.equal(attrInt(fib, "jaiph.step.seq"), "2");
  assert.equal(attrInt(fib, "jaiph.step.depth"), "1");
  assert.equal(attrInt(fib, "jaiph.step.status"), "0");
  assert.equal(attrInt(fib, "jaiph.step.elapsed_ms"), "100");
  assert.equal(attrString(fib, "jaiph.step.out"), "ok\n");
  assert.equal(fib.startTimeUnixNano, nano(T.fibStart));
  assert.equal(fib.endTimeUnixNano, nano(T.fibEnd));
});

test("runSummaryToOtlp: failed step → span status 2", () => {
  const boom = spansOf(runSummaryToOtlp(fixtureLines(), META)).find((s) => s.spanId === spanIdFor("R:3"))!;
  assert.equal(boom.status.code, 2);
  assert.equal(attrInt(boom, "jaiph.step.status"), "1");
  assert.equal(attrString(boom, "jaiph.step.err"), "bad\n");
});

test("runSummaryToOtlp: prompt span is a child of its step_id with backend/model attributes", () => {
  const spans = spansOf(runSummaryToOtlp(fixtureLines(), META));
  const prompt = spans.find((s) => s.name === "prompt claude" && s.attributes?.some((a) => a.key === "jaiph.prompt.backend"))!;
  assert.ok(prompt, "prompt span present");
  assert.equal(prompt.parentSpanId, spanIdFor("R:p1"), "prompt parented to its step_id");
  assert.equal(attrString(prompt, "jaiph.prompt.backend"), "claude");
  assert.equal(attrString(prompt, "jaiph.prompt.model"), "sonnet");
  assert.equal(attrInt(prompt, "jaiph.prompt.status"), "0");
  assert.equal(prompt.status.code, 1);
});

test("runSummaryToOtlp: unmatched STEP_START closes with ERROR at the last event time", () => {
  const hang = spansOf(runSummaryToOtlp(fixtureLines(), META)).find((s) => s.spanId === spanIdFor("R:4"))!;
  assert.equal(hang.status.code, 2, "a crashed (no STEP_END) step is ERROR");
  assert.equal(hang.startTimeUnixNano, nano(T.hangStart));
  assert.equal(hang.endTimeUnixNano, nano(T.wfEnd), "closes at the last event timestamp");
  // No STEP_END → no status/elapsed attributes.
  assert.equal(attrInt(hang, "jaiph.step.status"), undefined);
});

test("runSummaryToOtlp: LOGERR becomes a span event on the root span", () => {
  const root = spansOf(runSummaryToOtlp(fixtureLines(), META)).find((s) => s.name === "workflow default")!;
  assert.equal(root.events?.length, 1);
  const ev = root.events![0];
  assert.equal(ev.timeUnixNano, nano(T.log));
  assert.equal(ev.attributes.find((a) => a.key === "level")?.value.stringValue, "LOGERR");
  assert.equal(ev.attributes.find((a) => a.key === "message")?.value.stringValue, "warn-line");
});

test("runSummaryToOtlp: resource carries service.name, OTEL pairs, and jaiph.* attributes", () => {
  const payload = runSummaryToOtlp(fixtureLines(), META);
  const rs = (payload.resourceSpans as Array<Record<string, unknown>>)[0];
  const attrs = (rs.resource as { attributes: Array<{ key: string; value: { stringValue: string } }> }).attributes;
  const byKey = new Map(attrs.map((a) => [a.key, a.value.stringValue]));
  assert.equal(byKey.get("service.name"), "jaiph");
  assert.equal(byKey.get("jaiph.version"), "9.9.9");
  assert.equal(byKey.get("deployment.environment"), "ci");
  assert.equal(byKey.get("jaiph.run_id"), RUN_ID);
  assert.equal(byKey.get("jaiph.workflow"), "default");
  assert.equal(byKey.get("jaiph.source"), "fib.jh");
});

test("runSummaryToOtlp: ids are deterministic across two invocations", () => {
  const a = JSON.stringify(runSummaryToOtlp(fixtureLines(), META));
  const b = JSON.stringify(runSummaryToOtlp(fixtureLines(), META));
  assert.equal(a, b);
});

test("resolveOtlpEndpoint: traces-specific verbatim; generic gets /v1/traces; traces wins", () => {
  assert.equal(resolveOtlpEndpoint({}), undefined);
  assert.equal(
    resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" }),
    "http://c:4318/v1/traces",
  );
  assert.equal(
    resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }),
    "http://c:4318/v1/traces",
  );
  assert.equal(
    resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" }),
    "http://c:4318/v1/traces",
    "a trailing slash on the base endpoint is not doubled",
  );
  assert.equal(
    resolveOtlpEndpoint({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://base:4318",
    }),
    "http://traces:4318/v1/traces",
    "traces-specific wins over generic",
  );
});

test("parseKeyValueList: comma-separated k=v with = allowed in values", () => {
  assert.deepEqual(parseKeyValueList(undefined), {});
  assert.deepEqual(parseKeyValueList(""), {});
  assert.deepEqual(parseKeyValueList("a=1, b=2"), { a: "1", b: "2" });
  assert.deepEqual(
    parseKeyValueList("authorization=Bearer abc=def"),
    { authorization: "Bearer abc=def" },
    "only the first = splits key from value",
  );
  assert.deepEqual(parseKeyValueList("bad,c=3"), { c: "3" }, "entries without = are skipped");
});

test("exportRunTelemetry: warns and skips when the protocol is not http/json", async () => {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };
  try {
    await exportRunTelemetry({
      runDir: "/nonexistent",
      workflow: "default",
      exitStatus: 0,
      signal: null,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      },
    });
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.equal(captured.length, 1, "exactly one warning line");
  assert.match(captured[0], /http\/json/);
  assert.match(captured[0], /grpc/);
});

test("exportRunTelemetry: no OTLP endpoint → no-op, no output", async () => {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };
  try {
    await exportRunTelemetry({ runDir: "/nonexistent", workflow: "default", exitStatus: 0, signal: null, env: {} });
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.equal(captured.length, 0);
});

test("resolveFlushBudgetMs: default when unset, override when positive, fallback on junk", () => {
  assert.equal(resolveFlushBudgetMs({}), 10_000);
  assert.equal(resolveFlushBudgetMs({ JAIPH_TELEMETRY_FLUSH_MS: "2500" }), 2500);
  assert.equal(resolveFlushBudgetMs({ JAIPH_TELEMETRY_FLUSH_MS: "0" }), 10_000, "0 is non-positive → default");
  assert.equal(resolveFlushBudgetMs({ JAIPH_TELEMETRY_FLUSH_MS: "-5" }), 10_000, "negative → default");
  assert.equal(resolveFlushBudgetMs({ JAIPH_TELEMETRY_FLUSH_MS: "abc" }), 10_000, "unparseable → default");
});

/** Accepts a connection and never responds — an awaited POST hangs until the budget. */
function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((req) => req.resume());
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Minimal failed-run journal: one workflow + one nonzero step, with a run_id. */
function writeFailedJournal(dir: string): void {
  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lines = [
    { type: "WORKFLOW_START", workflow: "default", source: "x.jh", ts: "2026-04-21T16:02:00Z", run_id: runId },
    { type: "STEP_END", func: "boom", kind: "script", name: "boom", ts: "2026-04-21T16:02:01Z", status: 1, id: "R:2", run_id: runId, out_content: "", err_content: "bad\n" },
    { type: "WORKFLOW_END", workflow: "default", source: "x.jh", ts: "2026-04-21T16:02:02Z", run_id: runId },
  ];
  writeFileSync(join(dir, "run_summary.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
}

// Finding H-3: a tampered journal is never exported — verification runs before
// any POST, so a broken chain returns "failed" without touching the network.
test("exportOtlpTraces: hard-fails without POSTing when the journal chain fails verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-otlp-tamper-"));
  try {
    writeFailedJournal(dir); // no valid keyed chain
    writeChainKey(dir, "k".repeat(64)); // key present → verifiable → fails
    const warnings: string[] = [];
    const outcome = await exportOtlpTraces(
      { runDir: dir, workflow: "default", exitStatus: 1, signal: null, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" } },
      1000,
      (m) => warnings.push(m),
    );
    assert.equal(outcome, "failed");
    assert.ok(warnings.some((w) => w.includes("integrity verification")), `expected an integrity warning, got: ${warnings.join("")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportRunTelemetry: OTLP + Sentry run concurrently under one shared flush budget", async () => {
  const hole = await startBlackHole();
  const dir = mkdtempSync(join(tmpdir(), "jaiph-flush-"));
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    writeFailedJournal(dir);
    // Budget is sized to dominate event-loop lag: node:test runs files in
    // parallel processes, so a loaded suite can starve this loop and delay the
    // socket-timeout timers. Both exporters hang until their shared timeout, so
    // concurrent-under-one-budget finishes near 1x the budget while a sequential
    // await would need 2x. The gap between the two is exactly one budget
    // regardless of lag, so a ceiling strictly below 2x proves concurrency; a
    // large budget keeps that gap wide relative to lag so it does not flake.
    const budgetMs = 1500;
    const started = Date.now();
    await exportRunTelemetry({
      runDir: dir,
      workflow: "default",
      exitStatus: 1,
      signal: null,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${hole.port}`,
        SENTRY_DSN: `http://key@127.0.0.1:${hole.port}/1`,
        JAIPH_TELEMETRY_FLUSH_MS: String(budgetMs),
      },
    });
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < budgetMs * 1.8,
      `concurrent flush should be under ~one budget, took ${elapsed}ms (budget ${budgetMs}ms)`,
    );
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    await hole.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportOtlpTraces: identity is exported as jaiph.principal / jaiph.correlation_id resource attributes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-otlp-id-"));
  let captured: Record<string, unknown> | undefined;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      captured = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    writeFailedJournal(dir);
    const outcome = await exportOtlpTraces(
      {
        runDir: dir,
        workflow: "default",
        exitStatus: 1,
        signal: null,
        env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces` },
        identity: { principal: "alice", correlationId: "corr-123" },
      },
      5000,
      () => {},
    );
    assert.equal(outcome, "sent");
    const rs = (captured!.resourceSpans as Array<Record<string, unknown>>)[0];
    const attrs = (rs.resource as { attributes: Array<{ key: string; value: { stringValue?: string } }> }).attributes;
    const get = (k: string): string | undefined => attrs.find((a) => a.key === k)?.value.stringValue;
    assert.equal(get("jaiph.principal"), "alice");
    assert.equal(get("jaiph.correlation_id"), "corr-123");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deliverRunTelemetryDetached: failures are tracked in bounded metrics, never thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-detached-"));
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    writeFailedJournal(dir);
    const before = telemetryDeliveryMetrics();
    // A refused port (bind then release) fails fast for both exporters.
    const refused = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    deliverRunTelemetryDetached({
      runDir: dir,
      workflow: "default",
      exitStatus: 1,
      signal: null,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${refused}`,
        SENTRY_DSN: `http://key@127.0.0.1:${refused}/1`,
        JAIPH_TELEMETRY_FLUSH_MS: "1000",
      },
    });
    // Poll the metrics until both failures register (delivery is fire-and-forget).
    const deadline = Date.now() + 5_000;
    for (;;) {
      const m = telemetryDeliveryMetrics();
      if (m.otlpFailures > before.otlpFailures && m.sentryFailures > before.sentryFailures) break;
      if (Date.now() > deadline) {
        assert.fail(`metrics did not register both failures: ${JSON.stringify(m)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
