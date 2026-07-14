import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

/**
 * Drives a live `jaiph mcp` child over its stdio JSON-RPC transport. Buffers
 * every stdout line (so tests can assert stdout is *only* JSON-RPC) and every
 * stderr chunk (diagnostics land there), and lets tests await responses by id
 * or notifications by method.
 */
interface McpClient {
  send(message: Record<string, unknown>): void;
  waitFor(predicate: (m: Record<string, unknown>) => boolean, label: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  stdoutLines(): string[];
  stderr(): string;
  close(): Promise<void>;
}

function startMcp(fixture: string, cwd: string, env: NodeJS.ProcessEnv, alias = false): McpClient {
  const argv = alias ? ["--mcp", fixture] : ["mcp", fixture];
  const child: ChildProcessWithoutNullStreams = spawn("node", [CLI_PATH, ...argv], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const rawLines: string[] = [];
  const messages: Array<{ msg: Record<string, unknown>; claimed: boolean }> = [];
  const waiters: Array<{ predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  let stderrBuf = "";
  let stdoutBuf = "";

  const tryWaiters = (): void => {
    for (let wi = 0; wi < waiters.length; wi += 1) {
      const w = waiters[wi];
      const entry = messages.find((e) => !e.claimed && w.predicate(e.msg));
      if (entry) {
        entry.claimed = true;
        waiters.splice(wi, 1);
        w.resolve(entry.msg);
        wi -= 1;
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length > 0) {
        rawLines.push(line);
        messages.push({ msg: JSON.parse(line) as Record<string, unknown>, claimed: false });
      }
      idx = stdoutBuf.indexOf("\n");
    }
    tryWaiters();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
  });

  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(predicate, label, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const entry = messages.find((e) => !e.claimed && predicate(e.msg));
        if (entry) {
          entry.claimed = true;
          resolve(entry.msg);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${label}\nstderr:\n${stderrBuf}\nstdout:\n${rawLines.join("\n")}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    stdoutLines: () => [...rawLines],
    stderr: () => stderrBuf,
    close() {
      return new Promise((resolve) => {
        child.on("exit", () => resolve());
        child.stdin.end();
        setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000).unref();
      });
    },
  };
}

function mcpEnv(runsRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_DOCKER_ENABLED: "false",
    JAIPH_RUNS_DIR: runsRoot,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

const TWO_WORKFLOW_FIXTURE = [
  "# Greets the given name.",
  "workflow greet(name) {",
  '  return "hello ${name}"',
  "}",
  "",
  "# Fails on purpose for tests.",
  "workflow boom() {",
  '  fail "boom went off"',
  "}",
  "",
].join("\n");

async function initialize(client: McpClient): Promise<Record<string, unknown>> {
  client.send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
  });
  const res = await client.waitFor((m) => m.id === 0, "initialize response");
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return res;
}

test("jaiph mcp: scripted stdio session (initialize, list, call, invalid-params, failure)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-session-"));
  const client = startMcp(join(root, "tools.jh"), root, mcpEnv(join(root, ".jaiph/runs")));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, TWO_WORKFLOW_FIXTURE);

    // initialize
    const init = await initialize(client);
    const initResult = init.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
    assert.equal(initResult.protocolVersion, "2025-06-18");
    assert.deepEqual(initResult.capabilities, { tools: { listChanged: true } });
    assert.equal(initResult.serverInfo.name, "jaiph");

    // tools/list — both tools, comment-derived descriptions
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const list = await client.waitFor((m) => m.id === 1, "tools/list response");
    const tools = (list.result as { tools: Array<{ name: string; description: string }> }).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.deepEqual([...byName.keys()].sort(), ["boom", "greet"]);
    assert.equal(byName.get("greet")!.description, "Greets the given name.");
    assert.equal(byName.get("boom")!.description, "Fails on purpose for tests.");

    // tools/call greet — returns the workflow's return value as text
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "world" } },
    });
    const call = await client.waitFor((m) => m.id === 2, "greet call response");
    const callResult = call.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    assert.equal(callResult.isError, false);
    assert.deepEqual(callResult.content, [{ type: "text", text: "hello world" }]);

    // missing required arg → -32602
    client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "greet", arguments: {} } });
    const missing = await client.waitFor((m) => m.id === 3, "missing-arg response");
    assert.equal((missing.error as { code: number }).code, -32602);

    // failing workflow → isError with a run-dir pointer (not a protocol error)
    client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } });
    const boom = await client.waitFor((m) => m.id === 4, "boom call response");
    assert.equal(boom.error, undefined, "workflow failure must not be a protocol error");
    const boomResult = boom.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(boomResult.isError, true);
    assert.match(boomResult.content[0].text, /run dir:/);

    // Every stdout line is valid JSON-RPC 2.0 — no banner/progress leakage.
    for (const line of client.stdoutLines()) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0", `non-JSON-RPC stdout line: ${line}`);
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp: hot reload adds a tool (list_changed) and a broken edit keeps the previous tool set", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-reload-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, TWO_WORKFLOW_FIXTURE);
  const client = startMcp(jh, root, mcpEnv(join(root, ".jaiph/runs")));
  try {
    await initialize(client);

    // Edit the fixture to add a third workflow → list_changed, then it lists.
    writeFileSync(
      jh,
      `${TWO_WORKFLOW_FIXTURE}\n# A freshly added tool.\nworkflow extra() {\n  return "extra"\n}\n`,
    );
    await client.waitFor(
      (m) => m.method === "notifications/tools/list_changed",
      "list_changed after adding a workflow",
    );
    client.send({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    const list = await client.waitFor((m) => m.id === 10, "tools/list after reload");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["boom", "extra", "greet"]);

    // Break the fixture → reload fails; the previous tool set still serves and
    // a diagnostic appears on stderr.
    writeFileSync(jh, "workflow greet(name) {\n  return \"broken\n}\n");
    await pollUntil(() => /reload failed/.test(client.stderr()), 20_000, "reload-failure diagnostic on stderr");
    client.send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    const stillList = await client.waitFor((m) => m.id === 11, "tools/list after a broken edit");
    const stillNames = (stillList.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    assert.deepEqual(stillNames, ["boom", "extra", "greet"], "broken reload must keep the previous tool set");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp: compile diagnostics go to stderr with exit 1 and nothing on stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-diag-"));
  try {
    const jh = join(root, "broken.jh");
    // Reference to an undeclared workflow — a recoverable compile diagnostic.
    writeFileSync(jh, ["workflow default() {", "  run nonexistent()", "}", ""].join("\n"));
    const result = spawnSync("node", [CLI_PATH, "mcp", jh], {
      encoding: "utf8",
      cwd: root,
      env: mcpEnv(join(root, ".jaiph/runs")),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.equal(result.stdout, "", `stdout must be empty, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(result.stderr.length > 0, "a diagnostic should appear on stderr");
    assert.match(result.stderr, /nonexistent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph --help lists jaiph mcp", () => {
  const result = spawnSync("node", [CLI_PATH, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /jaiph mcp/);
});

test("jaiph --mcp dispatches to the same command as jaiph mcp", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-alias-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, TWO_WORKFLOW_FIXTURE);
  const client = startMcp(jh, root, mcpEnv(join(root, ".jaiph/runs")), true);
  try {
    const init = await initialize(client);
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "jaiph");
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const list = await client.waitFor((m) => m.id === 1, "tools/list over --mcp alias");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["boom", "greet"]);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run regression: a default workflow exits 0 and prints its return value", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-regression-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, ["workflow default() {", '  return "ran-ok"', "}", ""].join("\n"));
    const result = spawnSync("node", [CLI_PATH, "run", jh], {
      encoding: "utf8",
      cwd: root,
      env: mcpEnv(join(root, ".jaiph/runs")),
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /ran-ok/, `stdout should print the return value: ${result.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function pollUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}
