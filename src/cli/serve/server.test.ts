import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { closeSync, createReadStream, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync, type ReadStream } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer, listen, readBody } from "./server";
import { ServeHandler } from "./handler";
import { CHAIN_GENESIS, chainHmac, writeChainKey } from "../../runtime/kernel/emit";
import { RuntimeEventEmitter } from "../../runtime/kernel/runtime-event-emitter";
import type { McpToolSpec } from "../shared/mcp-tools";
import type { WorkflowCallResult } from "../shared/workflow-call";

const NOARG_TOOL: McpToolSpec = {
  name: "ping",
  workflow: "ping",
  description: "Pings.",
  params: [],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function makeHandler(callTool: () => Promise<WorkflowCallResult>): ServeHandler {
  let n = 0;
  return new ServeHandler({
    version: "0.0.0-test",
    serverTitle: "jaiph — test.jh",
    getTools: () => [NOARG_TOOL],
    callTool,
    maxConcurrent: 4,
    now: () => "2026-07-24T00:00:00.000Z",
    newRunId: () => `run-${n++}`,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.close(() => r());
    // fetch keeps idle keep-alive connections; sever them so close() resolves.
    server.closeAllConnections();
  });
}

// === readBody settlement ===

test("readBody settles promptly when a request closes before end", async () => {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const pending = readBody(req);
  (req as unknown as EventEmitter).emit("data", Buffer.from('{"partial":'));
  (req as unknown as EventEmitter).emit("close");
  const result = await Promise.race([pending, delay(500).then(() => "still-pending" as const)]);
  assert.notEqual(result, "still-pending", "readBody must settle on premature close, not hang");
  assert.deepEqual(result, { body: "", tooLarge: false, aborted: true });
});

test("readBody still resolves a complete body, with close after end being a no-op", async () => {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const pending = readBody(req);
  const emitter = req as unknown as EventEmitter;
  emitter.emit("data", Buffer.from('{"a":'));
  emitter.emit("data", Buffer.from("1}"));
  emitter.emit("end");
  emitter.emit("close");
  assert.deepEqual(await pending, { body: '{"a":1}', tooLarge: false, aborted: false });
});

// === destroying a request mid-upload ===

test("destroying a request mid-upload occupies no run slot and the server keeps serving", async () => {
  let calls = 0;
  const handler = makeHandler(async () => {
    calls += 1;
    return { text: "ok", isError: false, exitStatus: 0 };
  });
  const server = createHttpServer(handler, () => {});
  const port = await listen(server, "127.0.0.1", 0);
  try {
    const socket: Socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", () => r()));
    // Declare a bigger body than we send, then vanish mid-upload.
    socket.write(
      "POST /v1/workflows/ping/runs HTTP/1.1\r\n" +
        "host: localhost\r\n" +
        "content-type: application/json\r\n" +
        "content-length: 64\r\n" +
        "\r\n" +
        '{"half":',
    );
    await delay(50);
    socket.destroy();
    await delay(100);
    assert.equal(handler.inFlight(), 0, "the aborted request holds no run slot");
    assert.equal(calls, 0, "the aborted request never started a workflow");
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200, "the server still answers after the aborted upload");
  } finally {
    await closeServer(server);
  }
});

// === artifact streaming through a real socket ===

/** A finished run whose run_dir points at a temp dir with one published artifact. */
async function serveArtifact(payloadPath: string, payload: Buffer | null): Promise<{
  server: Server;
  port: number;
  runId: string;
  runDir: string;
}> {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-srv-art-"));
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "run_summary.jsonl"), "");
  if (payload !== null) writeFileSync(join(runDir, "artifacts", payloadPath), payload);
  const handler = makeHandler(async () => ({ text: "ok", isError: false, exitStatus: 0, runDir }));
  const server = createHttpServer(handler, () => {});
  const port = await listen(server, "127.0.0.1", 0);
  const res = await fetch(`http://127.0.0.1:${port}/v1/workflows/ping/runs?wait=true`, { method: "POST" });
  const runId = ((await res.json()) as { run_id: string }).run_id;
  return { server, port, runId, runDir };
}

// Finding H-3: the events endpoint must not stream a run whose keyed journal
// chain fails verification.
test("GET /v1/runs/{id}/events hard-fails (409) on a tampered journal, streams a clean one", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-srv-events-"));
  try {
    // A journal with no valid keyed chain, plus a persisted key → verifiable.
    writeFileSync(join(runDir, "run_summary.jsonl"), '{"type":"WORKFLOW_START","prev_hash":"deadbeef"}\n');
    writeChainKey(runDir, "k".repeat(64));
    const handler = makeHandler(async () => ({ text: "ok", isError: false, exitStatus: 0, runDir }));
    const server = createHttpServer(handler, () => {});
    const port = await listen(server, "127.0.0.1", 0);
    try {
      const create = await fetch(`http://127.0.0.1:${port}/v1/workflows/ping/runs?wait=true`, { method: "POST" });
      const runId = ((await create.json()) as { run_id: string }).run_id;

      const tampered = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}/events`);
      assert.equal(tampered.status, 409, "a tampered journal is rejected, not served");
      assert.equal(((await tampered.json()) as { error: { code: string } }).error.code, "E_TAMPERED");

      // Replace with a journal that verifies under the same key: a COMPLETE
      // terminal chain (keyed genesis for line 1, then a WORKFLOW_END whose
      // prev_hash links to it). A keyed run is only persisted once terminal, so
      // the verify boundary requires the WORKFLOW_END marker (finding L-3).
      const l0 = JSON.stringify({ type: "WORKFLOW_START", prev_hash: chainHmac("k".repeat(64), CHAIN_GENESIS) });
      const l1 = JSON.stringify({ type: "WORKFLOW_END", prev_hash: chainHmac("k".repeat(64), l0) });
      writeFileSync(join(runDir, "run_summary.jsonl"), `${l0}\n${l1}\n`);
      const clean = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}/events`);
      assert.equal(clean.status, 200, "a verifying journal streams normally");
      assert.match(clean.headers.get("content-type") ?? "", /application\/x-ndjson/);
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// AC4 (Broaden credential redaction): a newly-detected credential — a key the
// original four-suffix rule missed — is served as [REDACTED] on the /events
// path. The journal is written through the real RuntimeEventEmitter so this
// exercises the production redaction boundary end-to-end, not a hand-built line.
test("GET /v1/runs/{id}/events serves a newly-detected credential as [REDACTED]", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-srv-redact-"));
  const secret = "sk_live_super_secret_value_123";
  const prevSummaryFile = process.env.JAIPH_RUN_SUMMARY_FILE;
  try {
    process.env.JAIPH_RUN_SUMMARY_FILE = join(runDir, "run_summary.jsonl");
    const emitter = new RuntimeEventEmitter({
      runId: "run-redact",
      runDir,
      // STRIPE_SECRET_KEY ends in _KEY, not one of the original four suffixes.
      env: { STRIPE_SECRET_KEY: secret },
      getFrameStack: () => [],
      getAsyncIndices: () => [],
      suppressLiveEvents: true,
    });
    emitter.emitStep({ type: "STEP_END", out_content: `token leaked: ${secret}`, err_content: "" });

    const handler = makeHandler(async () => ({ text: "ok", isError: false, exitStatus: 0, runDir }));
    const server = createHttpServer(handler, () => {});
    const port = await listen(server, "127.0.0.1", 0);
    try {
      const create = await fetch(`http://127.0.0.1:${port}/v1/workflows/ping/runs?wait=true`, { method: "POST" });
      const runId = ((await create.json()) as { run_id: string }).run_id;
      const res = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}/events`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes(secret), "the secret must not appear in the served journal");
      assert.match(body, /\[REDACTED\]/, "the redaction marker must be present on the /events path");
    } finally {
      await closeServer(server);
    }
  } finally {
    if (prevSummaryFile === undefined) delete process.env.JAIPH_RUN_SUMMARY_FILE;
    else process.env.JAIPH_RUN_SUMMARY_FILE = prevSummaryFile;
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an artifact download round-trips byte-identically through a real socket with content-length", async () => {
  // A deterministic non-trivial payload, bigger than one stream chunk.
  const payload = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  const { server, port, runId, runDir } = await serveArtifact("blob.bin", payload);
  try {
    const dl = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}/artifacts/blob.bin`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-length"), String(payload.length));
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), payload, "streamed bytes match the artifact");
  } finally {
    await closeServer(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("disconnecting the client mid-download destroys the artifact file stream", async () => {
  // A sparse file far larger than the socket buffers, so a non-reading client
  // stalls the transfer on backpressure instead of letting it complete.
  const { server, port, runId, runDir } = await serveArtifact("big.bin", null);
  const bigPath = join(runDir, "artifacts", "big.bin");
  const fd = openSync(bigPath, "w");
  ftruncateSync(fd, 256 * 1024 * 1024);
  closeSync(fd);
  // The download endpoint serves the artifact's real path (symlinks resolved).
  const realBigPath = realpathSync(bigPath);
  // Patch the live CJS module object (what the compiled server reads at call
  // time) — the tsc `import *` namespace copy is getter-only.
  const fsAny = createRequire(__filename)("node:fs") as Record<string, unknown>;
  const origCreateReadStream = createReadStream;
  const created: ReadStream[] = [];
  try {
    fsAny.createReadStream = (...args: unknown[]): ReadStream => {
      const stream = (origCreateReadStream as (...a: unknown[]) => ReadStream)(...args);
      if (args[0] === realBigPath) created.push(stream);
      return stream;
    };
    const socket: Socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", () => r()));
    // Never read the response: kernel + stream buffers fill and backpressure
    // pauses the file stream mid-transfer.
    socket.pause();
    socket.write(`GET /v1/runs/${runId}/artifacts/big.bin HTTP/1.1\r\nhost: localhost\r\n\r\n`);
    await waitFor(() => created.length === 1, "the artifact file stream to open");
    assert.equal(created[0].destroyed, false, "the stalled stream stays open while the client is connected");
    socket.destroy();
    await waitFor(() => created[0].destroyed, "the file stream to be destroyed");
    assert.ok(created[0].destroyed, "client disconnect closes the file stream");
  } finally {
    fsAny.createReadStream = origCreateReadStream;
    await closeServer(server);
    rmSync(runDir, { recursive: true, force: true });
  }
});
