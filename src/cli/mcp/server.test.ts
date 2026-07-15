import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, type McpCallResult, type McpCallContext } from "./server";
import type { McpToolSpec } from "./tools";

/** A promise plus its resolver, so a fake `callTool` can settle on command. */
function deferred(): { promise: Promise<McpCallResult>; resolve: (r: McpCallResult) => void } {
  let resolve!: (r: McpCallResult) => void;
  const promise = new Promise<McpCallResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

function makeServer(overrides?: {
  callTool?: (spec: McpToolSpec, args: Record<string, string>, ctx: McpCallContext) => Promise<McpCallResult>;
  tools?: McpToolSpec[];
}) {
  const written: Array<Record<string, unknown>> = [];
  const logged: string[] = [];
  const server = new McpServer({
    serverVersion: "0.0.0-test",
    getTools: () => overrides?.tools ?? [BUILD_TOOL],
    callTool: overrides?.callTool ?? (async () => ({ text: "done", isError: false })),
    write: (m) => written.push(m),
    log: (m) => logged.push(m),
  });
  return { server, written, logged };
}

async function initialize(server: McpServer): Promise<void> {
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
  );
}

// === initialize ===

test("initialize: echoes a supported protocol version and advertises tools", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  const res = written[0] as { id: number; result: Record<string, unknown> };
  assert.equal(res.id, 0);
  assert.equal((res.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.deepEqual((res.result as { capabilities: unknown }).capabilities, { tools: { listChanged: true } });
});

test("initialize: falls back to the latest known version for unknown requests", async () => {
  const { server, written } = makeServer();
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }),
  );
  const res = written[0] as { result: { protocolVersion: string } };
  assert.equal(res.result.protocolVersion, "2025-06-18");
});

// === tools/list ===

test("tools/list: returns name, description, inputSchema", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const res = written[1] as { result: { tools: Array<Record<string, unknown>> } };
  assert.equal(res.result.tools.length, 1);
  assert.deepEqual(res.result.tools[0], {
    name: "build",
    description: "Builds the target.",
    inputSchema: BUILD_TOOL.inputSchema,
  });
});

// === tools/call ===

test("tools/call: maps arguments by name and returns text content", async () => {
  const calls: Array<{ workflow: string; args: Record<string, string> }> = [];
  const { server, written } = makeServer({
    callTool: async (spec, args) => {
      calls.push({ workflow: spec.workflow, args });
      return { text: "built app", isError: false };
    },
  });
  await initialize(server);
  await server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "build", arguments: { target: "app" } },
    }),
  );
  assert.deepEqual(calls, [{ workflow: "build", args: { target: "app" } }]);
  const res = written[1] as { result: { content: unknown; isError: boolean } };
  assert.deepEqual(res.result.content, [{ type: "text", text: "built app" }]);
  assert.equal(res.result.isError, false);
});

test("tools/call: workflow failure surfaces as isError result, not protocol error", async () => {
  const { server, written } = makeServer({
    callTool: async () => ({ text: "workflow build failed (exit 1)", isError: true }),
  });
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "build", arguments: { target: "x" } } }),
  );
  const res = written[1] as { result: { isError: boolean }; error?: unknown };
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
});

test("tools/call: unknown tool is invalid params", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }),
  );
  const res = written[1] as { error: { code: number; message: string } };
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /unknown tool/);
});

test("tools/call: missing required argument is invalid params", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "build", arguments: {} } }),
  );
  const res = written[1] as { error: { code: number; message: string } };
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /target/);
});

test("tools/call: unexpected argument key is invalid params", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  await server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "build", arguments: { target: "x", bogus: "y" } },
    }),
  );
  const res = written[1] as { error: { code: number; message: string } };
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /bogus/);
});

test("tools/call: a crashing callTool becomes an internal JSON-RPC error", async () => {
  const { server, written, logged } = makeServer({
    callTool: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "build", arguments: { target: "x" } } }),
  );
  const res = written[1] as { error: { code: number } };
  assert.equal(res.error.code, -32603);
  assert.equal(logged.length, 1);
});

// === progress notifications & cancellation ===

test("tools/call with progressToken: monotonic progress before the response, none after", async () => {
  let captured: McpCallContext | undefined;
  const call = deferred();
  const { server, written } = makeServer({
    callTool: async (_spec, _args, ctx) => {
      captured = ctx;
      return call.promise;
    },
  });
  await initialize(server);
  const callP = server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "build", arguments: { target: "app" }, _meta: { progressToken: "tok" } },
    }),
  );
  // Two step events arrive while the run is in flight.
  captured!.onStep!("run", "compile");
  captured!.onStep!("run", "link");
  // The run finishes and its response is sent.
  call.resolve({ text: "built", isError: false });
  await callP;
  // A late step event (after the response) must NOT produce a notification.
  captured!.onStep!("run", "late");

  const progress = written.filter((m) => m.method === "notifications/progress");
  assert.equal(progress.length, 2, "exactly the two in-flight step events notify");
  assert.deepEqual(progress[0].params, { progressToken: "tok", progress: 1, message: "run compile" });
  assert.deepEqual(progress[1].params, { progressToken: "tok", progress: 2, message: "run link" });

  // The response for id 20 exists and follows both progress notifications.
  const responseIdx = written.findIndex((m) => m.id === 20);
  const lastProgressIdx = written.map((m) => m.method).lastIndexOf("notifications/progress");
  assert.ok(responseIdx > lastProgressIdx, "progress must precede the response");
});

test("tools/call without progressToken: no onStep and no progress notifications", async () => {
  let captured: McpCallContext | undefined;
  const { server, written } = makeServer({
    callTool: async (_spec, _args, ctx) => {
      captured = ctx;
      return { text: "ok", isError: false };
    },
  });
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "build", arguments: { target: "x" } } }),
  );
  assert.equal(captured!.onStep, undefined, "no progressToken means no step forwarding");
  assert.equal(written.filter((m) => m.method === "notifications/progress").length, 0);
});

test("notifications/cancelled: kills the in-flight call, sends no response, keeps serving", async () => {
  let cancelled = false;
  const call = deferred();
  const { server, written } = makeServer({
    callTool: async (_spec, _args, ctx) => {
      // The executor registers its terminator; cancellation resolves the run.
      ctx.onCancelHandle?.(() => {
        cancelled = true;
        call.resolve({ text: "terminated by signal SIGINT", isError: true });
      });
      return call.promise;
    },
  });
  await initialize(server);
  const callP = server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "build", arguments: { target: "x" } } }),
  );
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 22 } }),
  );
  await callP;

  assert.equal(cancelled, true, "the child terminator ran");
  assert.equal(written.find((m) => m.id === 22), undefined, "a cancelled call sends no response");

  // The server still answers subsequent requests.
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 23, method: "ping" }));
  assert.deepEqual(written.find((m) => m.id === 23), { jsonrpc: "2.0", id: 23, result: {} });
});

test("notifications/cancelled arriving before the child spawns cancels once registered", async () => {
  let cancelled = false;
  let registerCancel: (() => void) | undefined;
  const call = deferred();
  const { server } = makeServer({
    callTool: async (_spec, _args, ctx) => {
      // Defer registering the terminator until after the cancel notification.
      registerCancel = () => ctx.onCancelHandle?.(() => {
        cancelled = true;
        call.resolve({ text: "terminated", isError: true });
      });
      return call.promise;
    },
  });
  await initialize(server);
  const callP = server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "build", arguments: { target: "x" } } }),
  );
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 24 } }),
  );
  // The executor only now spawns the child and registers its terminator.
  registerCancel!();
  await callP;
  assert.equal(cancelled, true, "a cancel that predates the child still terminates it");
});

test("notifications/cancelled for an unknown request id is a harmless no-op", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } }),
  );
  // Only the initialize response was written; the notification did nothing.
  assert.equal(written.length, 1);
});

// === protocol plumbing ===

test("ping: responds with an empty result", async () => {
  const { server, written } = makeServer();
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }));
  assert.deepEqual(written[0], { jsonrpc: "2.0", id: 9, result: {} });
});

test("notifications are ignored (no response written)", async () => {
  const { server, written } = makeServer();
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }));
  assert.equal(written.length, 0);
});

test("invalid JSON produces a parse error with null id", async () => {
  const { server, written } = makeServer();
  await server.handleLine("{not json");
  const res = written[0] as { id: null; error: { code: number } };
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32700);
});

test("a non-object JSON message is an invalid request with null id", async () => {
  const { server, written } = makeServer();
  await server.handleLine("[1, 2, 3]");
  const res = written[0] as { id: null; error: { code: number } };
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32600);
});

test("unknown request method is method-not-found", async () => {
  const { server, written } = makeServer();
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "resources/list" }));
  const res = written[0] as { error: { code: number } };
  assert.equal(res.error.code, -32601);
});

test("blank lines are ignored", async () => {
  const { server, written } = makeServer();
  await server.handleLine("");
  await server.handleLine("   ");
  assert.equal(written.length, 0);
});

// === notifyToolsChanged ===

test("notifyToolsChanged: emits only after initialize", () => {
  const { server, written } = makeServer();
  server.notifyToolsChanged();
  assert.equal(written.length, 0);
});

test("notifyToolsChanged: emits the list_changed notification once initialized", async () => {
  const { server, written } = makeServer();
  await initialize(server);
  server.notifyToolsChanged();
  assert.deepEqual(written[1], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
});
