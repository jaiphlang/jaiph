import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeHandler, type RunRecord, type ServeRequest, type ServeResponse } from "./handler";
import type { StreamTarget } from "./runfiles";
import type { McpToolSpec } from "../mcp/tools";
import type { WorkflowCallResult, WorkflowCallContext } from "../exec/call";

const BUILD_TOOL: McpToolSpec = {
  name: "build",
  workflow: "build",
  description: "Builds the target.",
  params: ["target"],
  inputSchema: {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
    additionalProperties: false,
  },
};

const NOARG_TOOL: McpToolSpec = {
  name: "ping",
  workflow: "ping",
  description: "Pings.",
  params: [],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

type CallTool = (
  spec: McpToolSpec,
  args: Record<string, string>,
  runId: string,
  ctx: WorkflowCallContext,
) => Promise<WorkflowCallResult>;

function makeHandler(overrides?: {
  callTool?: CallTool;
  tools?: McpToolSpec[];
  token?: string;
  maxConcurrent?: number;
  retainRuns?: number;
  retainAgeSec?: number;
  now?: () => string;
  resolveRunDir?: (record: RunRecord) => string | null;
  ssePollMs?: number;
  maxArtifactBytes?: number;
}): ServeHandler {
  let n = 0;
  return new ServeHandler({
    version: "0.0.0-test",
    serverTitle: "jaiph — test.jh",
    getTools: () => overrides?.tools ?? [BUILD_TOOL],
    callTool: overrides?.callTool ?? (async () => ({ text: "done", isError: false, exitStatus: 0 })),
    token: overrides?.token,
    maxConcurrent: overrides?.maxConcurrent ?? 4,
    retainRuns: overrides?.retainRuns,
    retainAgeSec: overrides?.retainAgeSec,
    now: overrides?.now ?? (() => "2026-07-24T00:00:00.000Z"),
    newRunId: () => `run-${n++}`,
    resolveRunDir: overrides?.resolveRunDir,
    ssePollMs: overrides?.ssePollMs,
    maxArtifactBytes: overrides?.maxArtifactBytes,
  });
}

function req(method: string, path: string, opts?: { headers?: Record<string, string>; body?: string; bodyTooLarge?: boolean }): ServeRequest {
  const url = new URL(path, "http://x");
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: opts?.headers ?? {},
    body: opts?.body ?? "",
    bodyTooLarge: opts?.bodyTooLarge,
  };
}

function bodyJson(res: ServeResponse): any {
  return JSON.parse(res.body);
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// === routing / unauthenticated surface ===

test("GET / redirects to /docs", async () => {
  const res = await makeHandler().handleRequest(req("GET", "/"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/docs");
});

test("GET /healthz reports status, version, tools, in_flight (unauthenticated)", async () => {
  const res = await makeHandler({ token: "secret" }).handleRequest(req("GET", "/healthz"));
  assert.equal(res.status, 200);
  const body = bodyJson(res);
  assert.equal(body.status, "ok");
  assert.equal(body.version, "0.0.0-test");
  assert.equal(body.tools, 1);
  assert.equal(body.in_flight, 0);
});

test("GET /openapi.json and /docs answer 200 unauthenticated even with a token set", async () => {
  const h = makeHandler({ token: "secret" });
  const openapi = await h.handleRequest(req("GET", "/openapi.json"));
  assert.equal(openapi.status, 200);
  assert.equal(bodyJson(openapi).openapi, "3.1.0");
  const docs = await h.handleRequest(req("GET", "/docs"));
  assert.equal(docs.status, 200);
  assert.match(docs.headers["content-type"], /text\/html/);
});

test("wrong method on a known path is 405", async () => {
  const res = await makeHandler().handleRequest(req("POST", "/healthz"));
  assert.equal(res.status, 405);
  assert.equal(bodyJson(res).error.code, "E_METHOD_NOT_ALLOWED");
});

// === auth matrix (token set) ===

test("auth matrix: /v1/* requires the bearer token when JAIPH_SERVE_TOKEN is set", async () => {
  const h = makeHandler({ token: "secret" });
  const none = await h.handleRequest(req("GET", "/v1/workflows"));
  assert.equal(none.status, 401);
  assert.equal(bodyJson(none).error.code, "E_UNAUTHORIZED");

  const wrong = await h.handleRequest(req("GET", "/v1/workflows", { headers: { authorization: "Bearer nope" } }));
  assert.equal(wrong.status, 401);

  const right = await h.handleRequest(req("GET", "/v1/workflows", { headers: { authorization: "Bearer secret" } }));
  assert.equal(right.status, 200);
  assert.deepEqual(bodyJson(right).workflows, [{ name: "build", description: "Builds the target.", params: ["target"] }]);
});

test("with no token configured, /v1/* is open (loopback default)", async () => {
  const res = await makeHandler().handleRequest(req("GET", "/v1/workflows"));
  assert.equal(res.status, 200);
});

// === POST run: validation ===

test("POST run for an unknown workflow is 404", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/nope/runs", { headers: { "content-type": "application/json" }, body: "{}" }),
  );
  assert.equal(res.status, 404);
  assert.equal(bodyJson(res).error.code, "E_NOT_FOUND");
});

test("POST run with a missing required param is 400", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/build/runs", { headers: { "content-type": "application/json" }, body: "{}" }),
  );
  assert.equal(res.status, 400);
  assert.equal(bodyJson(res).error.code, "E_BAD_ARGS");
  assert.match(bodyJson(res).error.message, /target/);
});

test("POST run with a non-string param is 400", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/build/runs", { headers: { "content-type": "application/json" }, body: JSON.stringify({ target: 5 }) }),
  );
  assert.equal(res.status, 400);
  assert.match(bodyJson(res).error.message, /target/);
});

test("POST run with an unexpected param key is 400", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/build/runs", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "x", bogus: "y" }),
    }),
  );
  assert.equal(res.status, 400);
  assert.match(bodyJson(res).error.message, /bogus/);
});

test("POST run with a non-JSON content type is 415", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/build/runs", { headers: { "content-type": "text/plain" }, body: "target=x" }),
  );
  assert.equal(res.status, 415);
  assert.equal(bodyJson(res).error.code, "E_UNSUPPORTED_MEDIA_TYPE");
});

test("POST run past the body cap is 413", async () => {
  const res = await makeHandler().handleRequest(
    req("POST", "/v1/workflows/build/runs", { headers: { "content-type": "application/json" }, bodyTooLarge: true }),
  );
  assert.equal(res.status, 413);
  assert.equal(bodyJson(res).error.code, "E_BODY_TOO_LARGE");
});

test("concurrency cap returns 429 beyond the limit", async () => {
  // callTool never resolves, so the first run stays in-flight and the second is
  // rejected by the cap of 1.
  const h = makeHandler({ maxConcurrent: 1, callTool: () => new Promise<WorkflowCallResult>(() => {}) });
  const first = await h.handleRequest(req("POST", "/v1/workflows/ping/runs"));
  // ping has no params; empty body is fine.
  const hp = makeHandler({ maxConcurrent: 1, tools: [NOARG_TOOL], callTool: () => new Promise<WorkflowCallResult>(() => {}) });
  const a = await hp.handleRequest(req("POST", "/v1/workflows/ping/runs"));
  assert.equal(a.status, 202);
  const b = await hp.handleRequest(req("POST", "/v1/workflows/ping/runs"));
  assert.equal(b.status, 429);
  assert.equal(bodyJson(b).error.code, "E_TOO_MANY_RUNS");
  void first;
});

// === async vs wait ===

test("async POST returns 202 with a Location header and a running run object", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], callTool: () => new Promise<WorkflowCallResult>(() => {}) });
  const res = await h.handleRequest(req("POST", "/v1/workflows/ping/runs"));
  assert.equal(res.status, 202);
  const body = bodyJson(res);
  assert.equal(body.status, "running");
  assert.equal(res.headers.location, `/v1/runs/${body.run_id}`);
});

test("?wait=true returns 200 with the terminal run object and result_text", async () => {
  const h = makeHandler({
    tools: [NOARG_TOOL],
    callTool: async () => ({ text: "hello world", isError: false, exitStatus: 0, runDir: "/runs/x" }),
  });
  const res = await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  assert.equal(res.status, 200);
  const body = bodyJson(res);
  assert.equal(body.status, "succeeded");
  assert.equal(body.result_text, "hello world");
  assert.equal(body.run_dir, "/runs/x");
});

test("a workflow failure is not an HTTP error: 200 with status failed and exit_status", async () => {
  const h = makeHandler({
    tools: [NOARG_TOOL],
    callTool: async () => ({ text: "workflow ping failed (exit 1)\n\nrun dir: /runs/x", isError: true, exitStatus: 1, runDir: "/runs/x" }),
  });
  const res = await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  assert.equal(res.status, 200);
  const body = bodyJson(res);
  assert.equal(body.status, "failed");
  assert.equal(body.exit_status, 1);
  assert.match(body.result_text, /run dir:/);
});

// === run inspection ===

test("GET /v1/runs/{id} for an unknown id is 404, and lists newest first", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }) });
  const notFound = await h.handleRequest(req("GET", "/v1/runs/does-not-exist"));
  assert.equal(notFound.status, 404);

  await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  const list = bodyJson(await h.handleRequest(req("GET", "/v1/runs")));
  assert.equal(list.runs.length, 2);
  // newest first: run-1 then run-0
  assert.equal(list.runs[0].run_id, "run-1");
  assert.equal(list.runs[1].run_id, "run-0");
});

// === run retention (bounded in-memory registry) ===

test("count retention evicts only the oldest terminal records, keeping the newest", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], retainRuns: 2, callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }) });
  for (let i = 0; i < 5; i += 1) {
    await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  }
  // 5 completed, retain 2 → only run-3 and run-4 (newest) survive.
  const ids = [...h.runs.keys()].sort();
  assert.deepEqual(ids, ["run-3", "run-4"]);
  const notFound = await h.handleRequest(req("GET", "/v1/runs/run-0"));
  assert.equal(notFound.status, 404, "evicted run is gone from the registry");
});

test("retention never evicts an active run even when the terminal budget is exceeded", async () => {
  let releaseActive!: (r: WorkflowCallResult) => void;
  let calls = 0;
  const h = makeHandler({
    tools: [NOARG_TOOL],
    retainRuns: 1,
    callTool: () => {
      calls += 1;
      // The first call stays in-flight; later calls resolve immediately.
      if (calls === 1) return new Promise<WorkflowCallResult>((r) => (releaseActive = r));
      return Promise.resolve({ text: "ok", isError: false, exitStatus: 0 });
    },
  });
  const active = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs")));
  assert.equal(active.status, "running");
  // Complete three more runs; with retainRuns=1 they churn, but the active run
  // must never be evicted.
  for (let i = 0; i < 3; i += 1) {
    await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  }
  assert.ok(h.runs.has(active.run_id), "the running run survives eviction");
  releaseActive({ text: "ok", isError: false, exitStatus: 0 });
  await flush();
});

test("age retention evicts a completed run once it is older than the window", async () => {
  let clock = "2026-07-24T00:00:00.000Z";
  const h = makeHandler({
    tools: [NOARG_TOOL],
    retainAgeSec: 60,
    now: () => clock,
    callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }),
  });
  // First run ends at T0.
  const first = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true")));
  assert.ok(h.runs.has(first.run_id));
  // Advance the clock 2 minutes; a new completion triggers age eviction of the
  // now-stale first run (ended > 60s ago).
  clock = "2026-07-24T00:02:00.000Z";
  await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  assert.ok(!h.runs.has(first.run_id), "the stale completed run was evicted");
});

// === /v1/runs pagination (bounded listing) ===

test("GET /v1/runs paginates: bounded default, stable newest-first order, total count", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }) });
  for (let i = 0; i < 5; i += 1) {
    await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  }
  const page = bodyJson(await h.handleRequest(req("GET", "/v1/runs?limit=2")));
  assert.equal(page.total, 5, "total reflects the full registry");
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 0);
  assert.deepEqual(page.runs.map((r: any) => r.run_id), ["run-4", "run-3"], "newest first");

  const next = bodyJson(await h.handleRequest(req("GET", "/v1/runs?limit=2&offset=2")));
  assert.deepEqual(next.runs.map((r: any) => r.run_id), ["run-2", "run-1"], "stable next page");
});

test("GET /v1/runs clamps limit to the maximum and cannot return an unbounded response", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }) });
  await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true"));
  const page = bodyJson(await h.handleRequest(req("GET", "/v1/runs?limit=999999")));
  assert.equal(page.limit, 1000, "limit clamped to MAX_RUNS_PAGE");

  // A malformed limit falls back to the bounded default rather than being unbounded.
  const bad = bodyJson(await h.handleRequest(req("GET", "/v1/runs?limit=abc")));
  assert.equal(bad.limit, 100);
});

// === cancellation ===

test("cancel: 202 then terminal cancelled, invoking child + container teardown", async () => {
  let childKilled = false;
  let containerStopped = false;
  let runPromise!: Promise<WorkflowCallResult>;
  const h = makeHandler({
    tools: [NOARG_TOOL],
    callTool: (_spec, _args, _runId, ctx) => {
      runPromise = new Promise<WorkflowCallResult>((resolve) => {
        ctx.onCancelHandle?.(() => {
          childKilled = true;
          containerStopped = true;
          resolve({ text: "terminated by signal SIGINT", isError: true, exitStatus: 1, signal: "SIGINT" });
        });
      });
      return runPromise;
    },
  });
  const start = await h.handleRequest(req("POST", "/v1/workflows/ping/runs"));
  assert.equal(start.status, 202);
  const runId = bodyJson(start).run_id;

  const cancel = await h.handleRequest(req("POST", `/v1/runs/${runId}/cancel`));
  assert.equal(cancel.status, 202);
  assert.equal(childKilled, true, "child terminator ran");
  assert.equal(containerStopped, true, "container teardown ran");

  await runPromise.catch(() => {});
  await flush();
  const record = bodyJson(await h.handleRequest(req("GET", `/v1/runs/${runId}`)));
  assert.equal(record.status, "cancelled");
});

test("cancel on an unknown run is 404; cancel on a terminal run is 409", async () => {
  const h = makeHandler({ tools: [NOARG_TOOL], callTool: async () => ({ text: "ok", isError: false, exitStatus: 0 }) });
  const missing = await h.handleRequest(req("POST", "/v1/runs/nope/cancel"));
  assert.equal(missing.status, 404);

  const start = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true")));
  const again = await h.handleRequest(req("POST", `/v1/runs/${start.run_id}/cancel`));
  assert.equal(again.status, 409);
  assert.equal(bodyJson(again).error.code, "E_RUN_TERMINAL");
});

// === events + artifacts ===

/** Run `ping` to completion with its `run_dir` pointed at a real temp dir. */
async function runWithDir(runDir: string): Promise<{ h: ServeHandler; runId: string }> {
  const h = makeHandler({
    tools: [NOARG_TOOL],
    callTool: async () => ({ text: "ok", isError: false, exitStatus: 0, runDir }),
  });
  const started = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true")));
  return { h, runId: started.run_id };
}

function fakeTarget(): StreamTarget & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (c: string) => void chunks.push(c),
    aborted: false,
    onAbort: () => {},
  };
}

test("events + artifacts on an unknown run id are 404", async () => {
  const h = makeHandler();
  for (const path of ["/v1/runs/nope/events", "/v1/runs/nope/artifacts", "/v1/runs/nope/artifacts/x.txt"]) {
    const res = await h.handleRequest(req("GET", path));
    assert.equal(res.status, 404, `${path} → 404`);
    assert.equal(bodyJson(res).error.code, "E_NOT_FOUND");
  }
});

test("events + artifacts require the bearer token when one is configured", async () => {
  const h = makeHandler({ token: "secret" });
  for (const path of ["/v1/runs/x/events", "/v1/runs/x/artifacts", "/v1/runs/x/artifacts/f"]) {
    assert.equal((await h.handleRequest(req("GET", path))).status, 401, `${path} → 401`);
  }
});

test("NDJSON events on a terminal run stream the run_summary.jsonl file itself", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-ndjson-"));
  try {
    const journal = '{"type":"WORKFLOW_START","run_id":"r"}\n{"type":"WORKFLOW_END","run_id":"r"}\n';
    writeFileSync(join(runDir, "run_summary.jsonl"), journal);
    const { h, runId } = await runWithDir(runDir);
    const res = await h.handleRequest(req("GET", `/v1/runs/${runId}/events`));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/x-ndjson");
    assert.ok(res.bodyFile, "NDJSON is streamed from a file, never buffered whole");
    assert.equal(res.bodyFile!.path, join(runDir, "run_summary.jsonl"), "the streamed file is the journal");
    assert.equal(res.bodyFile!.size, Buffer.byteLength(journal), "exactly the journal's bytes are streamed");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(journal)));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("SSE events on a terminal run replay the journal then close with event: end", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-sse-"));
  try {
    const lines = ['{"type":"WORKFLOW_START","run_id":"r"}', '{"type":"WORKFLOW_END","run_id":"r"}'];
    writeFileSync(join(runDir, "run_summary.jsonl"), lines.map((l) => `${l}\n`).join(""));
    const { h, runId } = await runWithDir(runDir);
    const res = await h.handleRequest(req("GET", `/v1/runs/${runId}/events`, { headers: { accept: "text/event-stream" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.ok(res.stream, "SSE is served as a stream");
    const target = fakeTarget();
    await res.stream!(target);
    const dataPayloads = target.chunks.filter((c) => c.startsWith("data: ")).map((c) => c.slice(6).replace(/\n\n$/, ""));
    assert.deepEqual(dataPayloads, lines);
    assert.equal(target.chunks[target.chunks.length - 1], "event: end\ndata: {}\n\n");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("artifacts round-trip through the handler: list then byte-identical download", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-art-"));
  try {
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    const payload = Buffer.from("artifact bytes\n binary", "utf8");
    writeFileSync(join(runDir, "artifacts", "out.bin"), payload);
    writeFileSync(join(runDir, "run_summary.jsonl"), "");
    const { h, runId } = await runWithDir(runDir);

    const list = await h.handleRequest(req("GET", `/v1/runs/${runId}/artifacts`));
    assert.equal(list.status, 200);
    assert.deepEqual(
      bodyJson(list).artifacts.map((a: any) => a.path),
      ["out.bin"],
    );

    const dl = await h.handleRequest(req("GET", `/v1/runs/${runId}/artifacts/out.bin`));
    assert.equal(dl.status, 200);
    assert.equal(dl.headers["content-type"], "application/octet-stream");
    assert.match(dl.headers["content-disposition"], /filename="out\.bin"/);
    assert.equal(dl.headers["content-length"], String(payload.length));
    assert.ok(dl.bodyFile, "the artifact is streamed from disk, never buffered whole");
    assert.equal(dl.bodyFile!.size, payload.length);
    assert.deepEqual(readFileSync(dl.bodyFile!.path), payload, "the streamed file is the published artifact");

    // Traversal to a run-dir file (not under artifacts/) is a 404.
    const escape = await h.handleRequest(req("GET", `/v1/runs/${runId}/artifacts/${encodeURIComponent("../run_summary.jsonl")}`));
    assert.equal(escape.status, 404);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** A stream target that records writes and can be aborted like a disconnecting client. */
function abortableTarget(): StreamTarget & { chunks: string[]; abort: () => void } {
  let aborted = false;
  const cbs: Array<() => void> = [];
  const chunks: string[] = [];
  return {
    chunks,
    write: (c: string) => void chunks.push(c),
    get aborted(): boolean {
      return aborted;
    },
    onAbort: (cb: () => void) => void cbs.push(cb),
    abort(): void {
      aborted = true;
      for (const cb of cbs) cb();
    },
  };
}

/** Poll until `target` holds at least `n` SSE `data:` frames. */
async function waitForDataFrames(target: { chunks: string[] }, n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (target.chunks.filter((c) => c.startsWith("data: ")).length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} SSE data frames`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a live SSE connection resolves the run dir with at most one scan", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-scan-"));
  try {
    const journal = join(runDir, "run_summary.jsonl");
    writeFileSync(journal, '{"type":"WORKFLOW_START","run_id":"r"}\n');
    let scans = 0;
    const h = makeHandler({
      tools: [NOARG_TOOL],
      // The run never finishes, so `run_dir` is never set on the record and
      // every poll must go through the resolver.
      callTool: () => new Promise<WorkflowCallResult>(() => {}),
      resolveRunDir: () => {
        scans += 1;
        return runDir;
      },
      ssePollMs: 5,
    });
    const started = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs")));
    const res = await h.handleRequest(req("GET", `/v1/runs/${started.run_id}/events`, { headers: { accept: "text/event-stream" } }));
    assert.ok(res.stream);
    const target = abortableTarget();
    const done = res.stream!(target);
    await waitForDataFrames(target, 1);
    // Grow the journal and wait for its frame — proof that later polls (each of
    // which resolves the run dir) happened after the first scan.
    appendFileSync(journal, '{"type":"STEP_END","status":0}\n');
    await waitForDataFrames(target, 2);
    target.abort();
    await done;
    assert.equal(scans, 1, "the runs tree was scanned exactly once for the whole live stream");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an artifact past maxArtifactBytes is 413 while a smaller one still streams", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-cap-"));
  try {
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "big.bin"), Buffer.alloc(10, 1));
    writeFileSync(join(runDir, "artifacts", "small.bin"), Buffer.alloc(4, 2));
    writeFileSync(join(runDir, "run_summary.jsonl"), "");
    const h = makeHandler({
      tools: [NOARG_TOOL],
      maxArtifactBytes: 4,
      callTool: async () => ({ text: "ok", isError: false, exitStatus: 0, runDir }),
    });
    const started = bodyJson(await h.handleRequest(req("POST", "/v1/workflows/ping/runs?wait=true")));

    const big = await h.handleRequest(req("GET", `/v1/runs/${started.run_id}/artifacts/big.bin`));
    assert.equal(big.status, 413);
    assert.equal(bodyJson(big).error.code, "E_ARTIFACT_TOO_LARGE");
    assert.match(bodyJson(big).error.message, /JAIPH_SERVE_MAX_ARTIFACT_BYTES/);

    const small = await h.handleRequest(req("GET", `/v1/runs/${started.run_id}/artifacts/small.bin`));
    assert.equal(small.status, 200);
    assert.equal(small.bodyFile!.size, 4);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("artifacts list is empty for a run with no published files", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-empty-"));
  try {
    writeFileSync(join(runDir, "run_summary.jsonl"), "");
    const { h, runId } = await runWithDir(runDir);
    const list = await h.handleRequest(req("GET", `/v1/runs/${runId}/artifacts`));
    assert.deepEqual(bodyJson(list).artifacts, []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
