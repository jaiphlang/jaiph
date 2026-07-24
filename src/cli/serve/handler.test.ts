import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeHandler, type ServeRequest, type ServeResponse } from "./handler";
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
}): ServeHandler {
  let n = 0;
  return new ServeHandler({
    version: "0.0.0-test",
    serverTitle: "jaiph — test.jh",
    getTools: () => overrides?.tools ?? [BUILD_TOOL],
    callTool: overrides?.callTool ?? (async () => ({ text: "done", isError: false, exitStatus: 0 })),
    token: overrides?.token,
    maxConcurrent: overrides?.maxConcurrent ?? 4,
    now: () => "2026-07-24T00:00:00.000Z",
    newRunId: () => `run-${n++}`,
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

test("NDJSON events on a terminal run byte-match the run_summary.jsonl file", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-h-ndjson-"));
  try {
    const journal = '{"type":"WORKFLOW_START","run_id":"r"}\n{"type":"WORKFLOW_END","run_id":"r"}\n';
    writeFileSync(join(runDir, "run_summary.jsonl"), journal);
    const { h, runId } = await runWithDir(runDir);
    const res = await h.handleRequest(req("GET", `/v1/runs/${runId}/events`));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/x-ndjson");
    assert.ok(res.bodyBuffer, "NDJSON is served as a binary body");
    assert.deepEqual(res.bodyBuffer, readFileSync(join(runDir, "run_summary.jsonl")), "byte-identical to the journal");
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
    assert.deepEqual(dl.bodyBuffer, payload, "downloaded bytes match the published file");

    // Traversal to a run-dir file (not under artifacts/) is a 404.
    const escape = await h.handleRequest(req("GET", `/v1/runs/${runId}/artifacts/${encodeURIComponent("../run_summary.jsonl")}`));
    assert.equal(escape.status, 404);
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
