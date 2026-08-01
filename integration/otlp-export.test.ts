import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

/** Close an HTTP server without waiting forever on keep-alive sockets. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeCollector {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** A minimal OTLP collector that records every request and replies `status`. */
function startCollector(status = 200): Promise<FakeCollector> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.writeHead(status);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        requests,
        close: () => closeServer(server),
      });
    });
  });
}

/** Poll until the collector has received at least `n` requests (or time out). */
function waitForCollector(collector: FakeCollector, n: number, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (collector.requests.length >= n) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${n} collector request(s): ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Bind then immediately release a port so a request to it is refused. */
function reservedClosedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * A "black-hole" endpoint: accepts the connection and reads the request but
 * never responds, so an *awaited* export would hang until the flush budget. It
 * lets a timing assertion prove delivery is detached (terminal result returns
 * without waiting on the hanging POST). All sockets are destroyed on close.
 */
function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req) => {
      req.resume(); // drain the body; never call res.end()
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => closeServer(server),
      });
    });
  });
}

interface ServeProc {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Token so serve starts whether or not anonymous loopback is still allowed. */
const SERVE_TOKEN = "otlp-export-integration-token";

/** Spawn `jaiph serve --port 0`, resolving once it logs its bound listen URL. */
function startServe(fixture: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ServeProc> {
  const child = spawn("node", [CLI_PATH, "serve", "--port", "0", fixture], {
    cwd,
    env: { ...env, JAIPH_SERVE_TOKEN: env.JAIPH_SERVE_TOKEN || SERVE_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start\nstderr:\n${stderrBuf}`)), 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/listening on (http:\/\/[^ ]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({
          baseUrl: m[1],
          close: () =>
            new Promise<void>((res) => {
              if (child.exitCode !== null || child.signalCode !== null) return res();
              child.once("exit", () => res());
              child.kill("SIGTERM");
              setTimeout(() => {
                child.kill("SIGKILL");
                res();
              }, 8_000).unref();
            }),
        });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (code ${code})\nstderr:\n${stderrBuf}`));
    });
  });
}

/**
 * Run the CLI asynchronously so the test process's event loop keeps running —
 * the in-process fake collector must be able to accept the export connection
 * while the run is in flight (spawnSync would block the loop and deadlock it).
 */
function runCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

function baseEnv(runsRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_DOCKER_ENABLED: "false",
    JAIPH_RUNS_DIR: runsRoot,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

const STEP_FIXTURE = [
  'script emit = `echo "hello"`',
  "workflow default() {",
  '  log "a log line"',
  '  logerr "an error line"',
  "  run emit()",
  '  return "done"',
  "}",
  "",
].join("\n");

function otlpWarnings(stderr: string): string[] {
  return stderr.split("\n").filter((l) => l.includes("OTLP trace export"));
}

test("jaiph run: with OTLP env, exactly one well-formed POST reaches /v1/traces", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-run-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, STEP_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: {
        ...baseEnv(join(root, ".jaiph/runs")),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
        OTEL_EXPORTER_OTLP_HEADERS: "x-test=abc",
        OTEL_SERVICE_NAME: "jaiph-it",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(collector.requests.length, 1, "exactly one export POST");
    const req = collector.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/traces", "generic endpoint gets /v1/traces appended");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-test"], "abc", "OTEL_EXPORTER_OTLP_HEADERS applied");

    const payload = JSON.parse(req.body) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: Array<{ name: string; traceId: string }> }>;
      }>;
    };
    const rs = payload.resourceSpans[0];
    const spans = rs.scopeSpans[0].spans;
    assert.ok(spans.some((s) => s.name === "workflow default"), "root span present");
    assert.ok(spans.some((s) => s.name === "script emit"), "step span present");
    assert.ok(spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId)), "trace id is 32 hex chars");
    const svc = rs.resource.attributes.find((a) => a.key === "service.name");
    assert.equal(svc?.value.stringValue, "jaiph-it", "OTEL_SERVICE_NAME used");
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run --raw: standalone raw run exports exactly one trace", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-raw-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, STEP_FIXTURE);
    const result = await runCli(["run", "--raw", jh], {
      cwd: root,
      env: {
        ...baseEnv(join(root, ".jaiph/runs")),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    // A one-shot raw run awaits the export before exit, so the POST has landed.
    assert.equal(collector.requests.length, 1, "standalone --raw exports exactly one trace");
    assert.equal(collector.requests[0].url, "/v1/traces");
    const payload = JSON.parse(collector.requests[0].body) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(spans.some((s) => s.name === "workflow default"), "root span present in raw export");
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: with no OTLP env, nothing is exported", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-none-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, STEP_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: baseEnv(join(root, ".jaiph/runs")),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(collector.requests.length, 0, "no OTEL env → no export");
    assert.equal(otlpWarnings(result.stderr).length, 0);
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: a collector 500 keeps exit 0 and prints exactly one warning", async () => {
  const collector = await startCollector(500);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-500-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, STEP_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: {
        ...baseEnv(join(root, ".jaiph/runs")),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/traces`,
      },
    });
    assert.equal(result.status, 0, "telemetry is never load-bearing");
    assert.equal(collector.requests.length, 1, "one POST was attempted");
    const warns = otlpWarnings(result.stderr);
    assert.equal(warns.length, 1, `exactly one warning line, got: ${result.stderr}`);
    assert.match(warns[0], /HTTP 500/);
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: a refused collector keeps exit 0 and prints exactly one warning", async () => {
  const port = await reservedClosedPort();
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-refused-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, STEP_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: {
        ...baseEnv(join(root, ".jaiph/runs")),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
      },
    });
    assert.equal(result.status, 0);
    const warns = otlpWarnings(result.stderr);
    assert.equal(warns.length, 1, `exactly one warning line, got: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: a credential in step output reaches the payload only as [REDACTED]", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-redact-"));
  const SECRET = "supersecretvalue";
  try {
    const jh = join(root, "app.jh");
    writeFileSync(
      jh,
      ['script leak = `printf %s "$SECRET_API_KEY"`', "workflow default() {", "  run leak()", "}", ""].join("\n"),
    );
    const result = await runCli(["run", jh], {
      cwd: root,
      env: {
        ...baseEnv(join(root, ".jaiph/runs")),
        SECRET_API_KEY: SECRET,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(collector.requests.length, 1);
    const body = collector.requests[0].body;
    assert.equal(body.includes(SECRET), false, "raw credential must never appear in the payload");
    assert.ok(body.includes("[REDACTED]"), "the redacted marker flows through from the journal");
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- MCP shared-call-layer export ------------------------------------------

interface McpMessage {
  id?: number;
  method?: string;
  result?: unknown;
  [k: string]: unknown;
}

test("MCP tools/call triggers exactly one export per call via the shared call layer", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-mcp-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, ["# Greets.", "workflow greet(name) {", '  return "hi ${name}"', "}", ""].join("\n"));
  const child: ChildProcessWithoutNullStreams = spawn("node", [CLI_PATH, "mcp", jh], {
    cwd: root,
    env: {
      ...baseEnv(join(root, ".jaiph/runs")),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const messages: McpMessage[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as McpMessage);
      idx = buf.indexOf("\n");
    }
  });

  const send = (m: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(m)}\n`);
  };
  const waitFor = (pred: (m: McpMessage) => boolean, label: string): Promise<McpMessage> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 20_000);
      const tick = (): void => {
        const found = messages.find(pred);
        if (found) {
          clearTimeout(timer);
          resolve(found);
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });

  try {
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    });
    await waitFor((m) => m.id === 0, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greet", arguments: { name: "x" } } });
    const call = await waitFor((m) => m.id === 1, "tools/call");
    assert.equal((call.result as { isError: boolean }).isError, false);

    // Delivery is detached: the tool response is sent (and the concurrency slot
    // released) before best-effort export, so the POST lands shortly *after* the
    // response rather than blocking it. Poll for the single request.
    await waitForCollector(collector, 1, "one export per tools/call");
    assert.equal(collector.requests.length, 1, "exactly one export per tools/call");
    assert.equal(collector.requests[0].url, "/v1/traces");
    const payload = JSON.parse(collector.requests[0].body) as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }>;
    };
    const wf = payload.resourceSpans[0].resource.attributes.find((a) => a.key === "jaiph.workflow");
    assert.equal(wf?.value.stringValue, "greet", "the tool's workflow symbol is on the resource");
  } finally {
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP tools/call: an unreachable collector cannot delay the tool response", async () => {
  const hole = await startBlackHole();
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-mcp-hole-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, ["# Greets.", "workflow greet(name) {", '  return "hi ${name}"', "}", ""].join("\n"));
  const child = spawn("node", [CLI_PATH, "mcp", jh], {
    cwd: root,
    env: {
      ...baseEnv(join(root, ".jaiph/runs")),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${hole.port}`,
      // Budget >> the asserted bound: an awaited export would block ~8 s.
      JAIPH_TELEMETRY_FLUSH_MS: "8000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: McpMessage[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as McpMessage);
      idx = buf.indexOf("\n");
    }
  });
  const send = (m: Record<string, unknown>): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
  const waitFor = (pred: (m: McpMessage) => boolean, label: string): Promise<McpMessage> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 6_000);
      const tick = (): void => {
        const found = messages.find(pred);
        if (found) return clearTimeout(timer), resolve(found);
        setTimeout(tick, 25);
      };
      tick();
    });

  try {
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    await waitFor((m) => m.id === 0, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const started = Date.now();
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greet", arguments: { name: "x" } } });
    const call = await waitFor((m) => m.id === 1, "tools/call");
    const elapsed = Date.now() - started;
    assert.equal((call.result as { isError: boolean }).isError, false);
    assert.ok(elapsed < 4_000, `tool response must not wait on the hanging export (took ${elapsed}ms)`);
  } finally {
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });
    await hole.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- HTTP `jaiph serve` shared-call-layer export ---------------------------

const GREET_SERVE_FIXTURE = ["# Greets.", "workflow greet(name) {", '  return "hi ${name}"', "}", ""].join("\n");

test("jaiph serve: an HTTP run exports exactly one trace via the shared call layer", async () => {
  const collector = await startCollector(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-serve-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, GREET_SERVE_FIXTURE);
    const serve = await startServe(jh, root, {
      ...baseEnv(join(root, ".jaiph/runs")),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    });
    try {
      const res = await fetch(`${serve.baseUrl}/v1/workflows/greet/runs?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVE_TOKEN}` },
        body: JSON.stringify({ name: "x" }),
      });
      const run = (await res.json()) as { status: string };
      assert.equal(run.status, "succeeded", JSON.stringify(run));

      await waitForCollector(collector, 1, "one export per HTTP run");
      assert.equal(collector.requests.length, 1, "exactly one export per HTTP run");
      assert.equal(collector.requests[0].url, "/v1/traces");
      const payload = JSON.parse(collector.requests[0].body) as {
        resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }>;
      };
      const wf = payload.resourceSpans[0].resource.attributes.find((a) => a.key === "jaiph.workflow");
      assert.equal(wf?.value.stringValue, "greet", "the workflow symbol is on the resource");
    } finally {
      await serve.close();
    }
  } finally {
    await collector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: an unreachable collector cannot delay a terminal ?wait=true result", async () => {
  const hole = await startBlackHole();
  const root = mkdtempSync(join(tmpdir(), "jaiph-otlp-serve-hole-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, GREET_SERVE_FIXTURE);
    const serve = await startServe(jh, root, {
      ...baseEnv(join(root, ".jaiph/runs")),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${hole.port}`,
      // Budget >> the asserted bound: an awaited export would block the terminal
      // result and its concurrency slot for ~8 s.
      JAIPH_TELEMETRY_FLUSH_MS: "8000",
    });
    try {
      const started = Date.now();
      const res = await fetch(`${serve.baseUrl}/v1/workflows/greet/runs?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVE_TOKEN}` },
        body: JSON.stringify({ name: "x" }),
      });
      const run = (await res.json()) as { status: string };
      const elapsed = Date.now() - started;
      assert.equal(run.status, "succeeded", JSON.stringify(run));
      assert.ok(elapsed < 4_000, `terminal result / slot must release before delivery (took ${elapsed}ms)`);
    } finally {
      await serve.close();
    }
  } finally {
    await hole.close();
    rmSync(root, { recursive: true, force: true });
  }
});
