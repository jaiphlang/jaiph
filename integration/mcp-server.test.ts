import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function startMcp(fixture: string, cwd: string, env: NodeJS.ProcessEnv, alias = false, extraArgv: string[] = []): McpClient {
  const argv = alias ? ["--mcp", fixture] : ["mcp", ...extraArgv, fixture];
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

const ENV_ECHO_FIXTURE = [
  'script echo_impl = `printf %s "$GREETING"`',
  "# Returns the GREETING env var the workflow process sees.",
  "workflow show() {",
  "  const g = run echo_impl()",
  '  return "${g}"',
  "}",
  "",
].join("\n");

test("jaiph mcp --env GREETING=hi: every tools/call sees the var in the result text", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-env-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, ENV_ECHO_FIXTURE);
  // Drop any inherited GREETING so the value can only come from --env.
  const env = mcpEnv(join(root, ".jaiph/runs"));
  delete env.GREETING;
  const client = startMcp(jh, root, env, false, ["--env", "GREETING=hi"]);
  try {
    await initialize(client);

    // Two calls: the pairs apply to every call for the server's lifetime.
    for (const id of [1, 2]) {
      client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "show", arguments: {} } });
      const res = await client.waitFor((m) => m.id === id, `show call ${id}`);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false, `call ${id} should succeed`);
      assert.deepEqual(result.content, [{ type: "text", text: "hi" }], `call ${id} sees GREETING=hi`);
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp --env GREETING (bare) forwards the host value to every call", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-env-bare-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, ENV_ECHO_FIXTURE);
  const env = mcpEnv(join(root, ".jaiph/runs"));
  env.GREETING = "from-host";
  const client = startMcp(jh, root, env, false, ["--env", "GREETING"]);
  try {
    await initialize(client);
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show", arguments: {} } });
    const res = await client.waitFor((m) => m.id === 1, "show call");
    const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "from-host" }]);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp --env KEY (bare) with KEY unset on the host aborts with E_ENV_MISSING before serving", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-env-missing-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, ENV_ECHO_FIXTURE);
    const env = mcpEnv(join(root, ".jaiph/runs"));
    delete env.NOPE_TOKEN;
    const result = spawnSync("node", [CLI_PATH, "mcp", "--env", "NOPE_TOKEN", jh], {
      encoding: "utf8",
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.equal(result.stdout, "", "no protocol output before the abort");
    assert.match(result.stderr, /E_ENV_MISSING/);
    assert.match(result.stderr, /NOPE_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp --env with a reserved key aborts with E_ENV_RESERVED", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-env-reserved-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, ENV_ECHO_FIXTURE);
    const result = spawnSync("node", [CLI_PATH, "mcp", "--env", "JAIPH_WORKSPACE=/x", jh], {
      encoding: "utf8",
      cwd: root,
      env: mcpEnv(join(root, ".jaiph/runs")),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /E_ENV_RESERVED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp with JAIPH_UNSAFE=true runs tool calls host-only (no sandbox)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-unsafe-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, TWO_WORKFLOW_FIXTURE);
  // Drop JAIPH_DOCKER_ENABLED and rely on JAIPH_UNSAFE to force host-only —
  // this pins the unsafe host-fallback branch of the Docker-parity path.
  const env = mcpEnv(join(root, ".jaiph/runs"));
  delete env.JAIPH_DOCKER_ENABLED;
  env.JAIPH_UNSAFE = "true";
  const client = startMcp(jh, root, env);
  try {
    await initialize(client);
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "world" } },
    });
    const call = await client.waitFor((m) => m.id === 1, "greet call (unsafe host mode)");
    const result = call.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "hello world" }]);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run --raw honors JAIPH_RUN_WORKFLOW (the symbol carried into the Docker inner run)", () => {
  // The Docker MCP path carries the tool's workflow symbol into the container's
  // `jaiph run --raw` via JAIPH_RUN_WORKFLOW. This pins that raw-mode honors it
  // (host-only, so it runs everywhere): selecting `boom` must fail, proving the
  // inner run does NOT hardcode `default` (which would succeed).
  const root = mkdtempSync(join(tmpdir(), "jaiph-raw-symbol-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, ["workflow default() {", '  return "ok"', "}", "", "workflow boom() {", '  fail "boom-failed"', "}", ""].join("\n"));

    const okResult = spawnSync("node", [CLI_PATH, "run", "--raw", jh], {
      encoding: "utf8",
      cwd: root,
      env: mcpEnv(join(root, ".jaiph/runs")),
    });
    assert.equal(okResult.status, 0, `default should exit 0, got ${okResult.status}\n${okResult.stderr}`);

    const boomEnv = mcpEnv(join(root, ".jaiph/runs"));
    boomEnv.JAIPH_RUN_WORKFLOW = "boom";
    const boomResult = spawnSync("node", [CLI_PATH, "run", "--raw", jh], {
      encoding: "utf8",
      cwd: root,
      env: boomEnv,
    });
    assert.equal(boomResult.status, 1, `boom should exit 1 (not run default), got ${boomResult.status}`);
    assert.match(boomResult.stderr, /boom-failed/, "boom's failure must surface, proving boom ran");
  } finally {
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

// Two script steps → four STEP_START/STEP_END events, enough to observe a
// monotonic progress stream.
const MULTI_STEP_FIXTURE = [
  "script step_impl = `true`",
  "# Runs two steps so progress notifications can be observed.",
  "workflow steps() {",
  "  run step_impl()",
  "  run step_impl()",
  '  return "done"',
  "}",
  "",
].join("\n");

test("jaiph mcp: a progressToken streams monotonic progress before the response and none after", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-progress-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, MULTI_STEP_FIXTURE);
  const client = startMcp(jh, root, mcpEnv(join(root, ".jaiph/runs")));
  try {
    await initialize(client);
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "steps", arguments: {}, _meta: { progressToken: "p1" } },
    });
    const res = await client.waitFor((m) => m.id === 1, "steps call response");
    assert.equal((res.result as { isError: boolean }).isError, false);

    // Reconstruct the exact stdout order to prove ordering relative to the response.
    const lines = client.stdoutLines().map((l) => JSON.parse(l) as Record<string, unknown>);
    const responseIdx = lines.findIndex((m) => m.id === 1 && "result" in m);
    assert.ok(responseIdx >= 0, "the call response is present");
    const progress = lines
      .map((m, i) => ({ m, i }))
      .filter((e) => e.m.method === "notifications/progress");

    assert.ok(progress.length >= 1, "at least one progress notification is emitted");
    for (const e of progress) {
      const p = e.m.params as { progressToken: unknown; progress: number; message: unknown };
      assert.equal(p.progressToken, "p1", "progress carries the request's token");
      assert.equal(typeof p.message, "string");
      assert.ok(e.i < responseIdx, "progress must precede the response — none after it");
    }
    const values = progress.map((e) => (e.m.params as { progress: number }).progress);
    for (let k = 1; k < values.length; k += 1) {
      assert.ok(values[k] > values[k - 1], `progress increases monotonically: ${values[k - 1]} -> ${values[k]}`);
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph mcp: a call without a progressToken emits no progress notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-noprogress-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, MULTI_STEP_FIXTURE);
  const client = startMcp(jh, root, mcpEnv(join(root, ".jaiph/runs")));
  try {
    await initialize(client);
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "steps", arguments: {} } });
    const res = await client.waitFor((m) => m.id === 1, "steps call response");
    assert.equal((res.result as { isError: boolean }).isError, false);
    const progress = client
      .stdoutLines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m.method === "notifications/progress");
    assert.equal(progress.length, 0, "no progressToken → no progress notifications");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// A step that sleeps, then writes a completion marker. Cancelling mid-sleep
// kills the run before the `&&` chain reaches the marker.
const CANCEL_FIXTURE = [
  'script slow_impl = `sleep 3 && printf done > "$JAIPH_WORKSPACE/done.txt"`',
  "# Sleeps, then writes a completion marker (skipped when cancelled).",
  "workflow slow() {",
  "  run slow_impl()",
  '  return "woke"',
  "}",
  "",
].join("\n");

test("jaiph mcp: notifications/cancelled kills the in-flight run, sends no response, and keeps serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-mcp-cancel-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, CANCEL_FIXTURE);
  const client = startMcp(jh, root, mcpEnv(join(root, ".jaiph/runs")));
  try {
    await initialize(client);
    // A progressToken lets us detect the run is in-flight (the sleeping step's
    // STEP_START arrives as progress before the 3s sleep elapses).
    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "slow", arguments: {}, _meta: { progressToken: "c1" } },
    });
    await client.waitFor(
      (m) => m.method === "notifications/progress" && (m.params as { progressToken?: unknown }).progressToken === "c1",
      "progress before cancel (run is in-flight)",
    );

    client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });

    // The server still answers other requests.
    client.send({ jsonrpc: "2.0", id: 6, method: "ping" });
    const pong = await client.waitFor((m) => m.id === 6, "ping after cancel");
    assert.deepEqual(pong.result, {});

    // Past the sleep window: the marker is absent only if the run was killed
    // mid-sleep — this is the observable proof the child was terminated.
    await delay(5_000);
    assert.equal(existsSync(join(root, "done.txt")), false, "cancelled run must not complete its sleep");
    const responseForCancelled = client
      .stdoutLines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((m) => m.id === 5);
    assert.equal(responseForCancelled, undefined, "a cancelled call must produce no response");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
