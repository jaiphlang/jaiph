import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
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

    // The export is awaited inside the shared call layer before the response is
    // sent, so by now exactly one POST has landed for this one call.
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
