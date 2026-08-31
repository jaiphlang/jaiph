import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One execution-policy contract across `jaiph run`, `jaiph serve`, and
 * `jaiph mcp` — the table below drives the same `--env` cases through all
 * three modes and asserts the same effective child env and the same
 * filesystem outcome.
 */

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

// `env_probe` reports the granted `use` keys (script env is sterile: a
// `--env` key reaches a script only through its `use` clause); `write_marker`
// makes workspace writes observable. The hook-contract tests run with no
// `--env` grant, so their fixture carries no `use` clause (an ungranted `use`
// key would fail the pre-flight before any hook fires).
function fixtureSource(useClause: string): string {
  return [
    `script env_probe${useClause} = \`printf '%s|%s' "\${PROBE_A:-unset}" "\${PROBE_B:-unset}"\``,
    'script write_marker = `printf \'marker\' > "$JAIPH_WORKSPACE/written.txt"`',
    "# Writes a workspace marker, then reports probe env values.",
    "export def probe_and_write() {",
    "  run write_marker()",
    "  const seen = run env_probe()",
    "  return seen",
    "}",
    "",
    "export def main() {",
    "  const seen = run probe_and_write()",
    "  return seen",
    "}",
    "",
  ].join("\n");
}

const FIXTURE = fixtureSource(" use PROBE_A PROBE_B");
const HOOK_FIXTURE = fixtureSource("");

/** Keys that must not leak in from the test-runner env. */
const CONTROL_KEYS = ["JAIPH_TRUST_PROJECT_HOOKS", "PROBE_A", "PROBE_B"];

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  for (const key of CONTROL_KEYS) delete env[key];
  return { ...env, ...extra };
}

function makeWorkspace(source: string = FIXTURE): { ws: string; fixture: string } {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-exec-policy-"));
  const fixture = join(ws, "tools.jh");
  writeFileSync(fixture, source);
  return { ws, fixture };
}

interface ModeOutcome {
  /** Process (run) or server-startup (serve/mcp) exit code; null = server served fine. */
  exitCode: number | null;
  /** Workflow result text (return value) when the call succeeded. */
  resultText?: string;
  stderr: string;
}

/** Direct mode: `jaiph run <flags> tools.jh`; result text is the printed return value. */
function runDirect(ws: string, fixture: string, flags: string[], env: NodeJS.ProcessEnv): ModeOutcome {
  const r = spawnSync("node", [CLI_PATH, "run", ...flags, fixture], { cwd: ws, env, encoding: "utf8", timeout: 60_000 });
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  return { exitCode: r.status, resultText: r.status === 0 ? lines[lines.length - 1] : undefined, stderr: r.stderr };
}

/**
 * HTTP mode: start `jaiph serve`, POST the workflow with ?wait=true, shut down.
 * `--allow-anonymous` opts into the no-auth loopback default, which is now a
 * startup error without the flag (finding M-2); it does not affect the
 * exec-policy posture this table observes.
 */
async function runServeMode(ws: string, fixture: string, flags: string[], env: NodeJS.ProcessEnv): Promise<ModeOutcome> {
  const child = spawn("node", [CLI_PATH, "serve", "--port", "0", "--allow-anonymous", ...flags, fixture], {
    cwd: ws,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderrBuf += chunk; });

  const started = await new Promise<{ baseUrl?: string; exitCode?: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve neither listened nor exited\nstderr:\n${stderrBuf}`)), 30_000);
    child.stderr!.on("data", () => {
      const m = stderrBuf.match(/listening on (http:\/\/[^ ]+)/);
      if (m) { clearTimeout(timer); resolve({ baseUrl: m[1] }); }
    });
    // "close" (not "exit") so a startup failure's stderr is fully flushed.
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1 }); });
  });
  if (started.baseUrl === undefined) {
    return { exitCode: started.exitCode ?? 1, stderr: stderrBuf };
  }
  try {
    const res = await fetch(`${started.baseUrl}/v1/defs/probe_and_write/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const run = (await res.json()) as { status: string; result_text: string };
    assert.equal(run.status, "succeeded", `serve run failed: ${run.result_text}`);
    return { exitCode: null, resultText: run.result_text, stderr: stderrBuf };
  } finally {
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });
  }
}

/** Minimal newline-JSON-RPC client for `jaiph mcp` over stdio. */
function startMcpClient(args: string[], cwd: string, env: NodeJS.ProcessEnv): {
  child: ChildProcessWithoutNullStreams;
  waitFor: (predicate: (m: Record<string, unknown>) => boolean, label: string) => Promise<Record<string, unknown>>;
  send: (m: Record<string, unknown>) => void;
  stderr: () => string;
  close: () => Promise<void>;
} {
  const child = spawn("node", [CLI_PATH, "mcp", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  // A startup failure (e.g. E_FLAG_CONFLICT) exits before reading stdin; the
  // client's writes then EPIPE, which must not crash the test process.
  child.stdin.on("error", () => {});
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as Record<string, unknown>);
      idx = stdoutBuf.indexOf("\n");
    }
    for (let i = 0; i < waiters.length; i += 1) {
      const m = messages.find((msg) => waiters[i].predicate(msg));
      if (m) {
        const w = waiters.splice(i, 1)[0];
        i -= 1;
        w.resolve(m);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderrBuf += chunk; });
  return {
    child,
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
    waitFor: (predicate, label) =>
      new Promise((resolve, reject) => {
        const found = messages.find(predicate);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}\nstderr:\n${stderrBuf}`)), 30_000);
        waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      }),
    stderr: () => stderrBuf,
    close: () =>
      new Promise((resolve) => {
        // A startup failure already exited before close() is called; waiting
        // for another "exit" would hang forever.
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.on("exit", () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  };
}

/** MCP mode: initialize, tools/call probe_and_write, read the text result. */
async function runMcpMode(ws: string, fixture: string, flags: string[], env: NodeJS.ProcessEnv): Promise<ModeOutcome> {
  const client = startMcpClient([...flags, fixture], ws, env);
  // "close" (not "exit") so a startup failure's stderr is fully flushed.
  const earlyExit = new Promise<number | null>((resolve) => client.child.on("close", (code) => resolve(code ?? 1)));
  try {
    client.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const first = await Promise.race([client.waitFor((m) => m.id === 0, "initialize"), earlyExit]);
    if (typeof first === "number" || first === null) {
      return { exitCode: first ?? 1, stderr: client.stderr() };
    }
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe_and_write", arguments: {} } });
    const call = await client.waitFor((m) => m.id === 1, "tools/call response");
    const result = call.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(result.isError, false, `mcp call failed: ${JSON.stringify(result.content)}`);
    return { exitCode: null, resultText: result.content[0].text, stderr: client.stderr() };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Table: the same --env case observed through all three modes
// ---------------------------------------------------------------------------

interface PolicyCase {
  name: string;
  flags: string[];
  env: Record<string, string>;
  /** Expected `PROBE_A|PROBE_B` as the child sees it. */
  expectProbe: string;
  /** Expected startup-posture fragment on serve/mcp stderr. */
  expectPosture: string;
}

const POLICY_CASES: PolicyCase[] = [
  {
    name: "--env passthrough (explicit value + host forward)",
    flags: ["--env", "PROBE_A=va", "--env", "PROBE_B"],
    env: { PROBE_B: "vb" },
    expectProbe: "va|vb",
    expectPosture: "execute on the host.",
  },
];

for (const c of POLICY_CASES) {
  test(`exec policy table: ${c.name} — identical child env and workspace writes in run, serve, and mcp`, async () => {
    const observations: Array<{ mode: string; probe: string; markerWritten: boolean }> = [];
    for (const mode of ["run", "serve", "mcp"] as const) {
      const { ws, fixture } = makeWorkspace();
      try {
        const env = cleanEnv(c.env);
        const outcome =
          mode === "run"
            ? runDirect(ws, fixture, c.flags, env)
            : mode === "serve"
              ? await runServeMode(ws, fixture, c.flags, env)
              : await runMcpMode(ws, fixture, c.flags, env);
        assert.notEqual(outcome.exitCode ?? 0, 1, `${mode} must succeed\nstderr:\n${outcome.stderr}`);
        assert.equal(outcome.resultText, c.expectProbe, `${mode}: effective child env`);
        if (mode !== "run") {
          assert.match(outcome.stderr, new RegExp(c.expectPosture.replace(/[()|\\]/g, "\\$&")), `${mode}: startup posture printed once`);
        }
        observations.push({ mode, probe: outcome.resultText ?? "", markerWritten: existsSync(join(ws, "written.txt")) });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
    // The contract: every mode observed the same child env and the same
    // filesystem outcome (host mode → the marker lands in the workspace).
    for (const o of observations) {
      assert.equal(o.probe, observations[0].probe, `${o.mode} matches run's child env`);
      assert.equal(o.markerWritten, true, `${o.mode}: workspace write landed (host mode has no isolation)`);
    }
  });
}

// ---------------------------------------------------------------------------
// Flags belonging to another command are usage errors
// ---------------------------------------------------------------------------

const WRONG_FLAG_CASES: Array<{ argv: string[]; expect: RegExp }> = [
  { argv: ["run", "--host", "127.0.0.1"], expect: /--host is not a jaiph run flag.*jaiph serve/ },
  { argv: ["run", "--port", "80"], expect: /--port is not a jaiph run flag.*jaiph serve/ },
  { argv: ["serve", "--target", "/tmp/x"], expect: /--target is not a jaiph serve flag.*jaiph run/ },
  { argv: ["serve", "--raw"], expect: /--raw is not a jaiph serve flag.*jaiph run/ },
  { argv: ["mcp", "--raw"], expect: /--raw is not a jaiph mcp flag.*jaiph run/ },
  { argv: ["mcp", "--port", "80"], expect: /--port is not a jaiph mcp flag.*jaiph serve/ },
  { argv: ["run", "--bogus"], expect: /unknown flag --bogus for jaiph run/ },
  { argv: ["serve", "--bogus"], expect: /unknown flag --bogus for jaiph serve/ },
];

for (const c of WRONG_FLAG_CASES) {
  test(`exec policy: jaiph ${c.argv.join(" ")} <file> is a usage error`, () => {
    const { ws, fixture } = makeWorkspace();
    try {
      const r = spawnSync("node", [CLI_PATH, ...c.argv, fixture], { cwd: ws, env: cleanEnv({}), encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 1);
      assert.match(r.stderr, c.expect);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle-hook contract: the same four events, same payload fields, in all
// three invocation modes (direct, HTTP, MCP)
// ---------------------------------------------------------------------------

const HOOK_EVENTS = ["run_start", "step_start", "step_end", "run_end"] as const;

function writeHooksConfig(ws: string): string {
  const hooksLog = join(ws, "hooks.log");
  mkdirSync(join(ws, ".jaiph"), { recursive: true });
  // Buffer the payload, then append payload+newline in ONE write — concurrent
  // hook processes append to the same log, and two-step appends interleave.
  const appender = ['p=$(cat); printf \'%s\\n\' "$p" >> "$HOOKS_LOG"'];
  writeFileSync(
    join(ws, ".jaiph", "hooks.json"),
    JSON.stringify({ run_start: appender, step_start: appender, step_end: appender, run_end: appender }),
  );
  return hooksLog;
}

function readHookEvents(hooksLog: string): Array<Record<string, unknown>> {
  if (!existsSync(hooksLog)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(hooksLog, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line still being written when we polled; the next poll re-reads it.
    }
  }
  return events;
}

async function waitForHookEvents(hooksLog: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const events = readHookEvents(hooksLog);
    const seen = new Set(events.map((e) => e.event));
    if (HOOK_EVENTS.every((name) => seen.has(name))) return events;
    if (Date.now() > deadline) {
      throw new Error(`hooks log incomplete; saw: ${events.map((e) => e.event).join(", ") || "(nothing)"}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The documented contract every mode must satisfy for its hook stream. */
function assertHookContract(events: Array<Record<string, unknown>>, fixture: string, ws: string, mode: string): void {
  const byType = (name: string) => events.filter((e) => e.event === name);
  for (const name of HOOK_EVENTS) {
    assert.ok(byType(name).length > 0, `${mode}: ${name} hook fired`);
  }
  for (const e of events) {
    assert.equal(e.run_path, fixture, `${mode}: run_path on every payload`);
    assert.equal(e.workspace, ws, `${mode}: workspace on every payload`);
    assert.ok(typeof e.run_id === "string" && e.run_id.length > 0, `${mode}: non-empty run_id on ${e.event}`);
    assert.ok(typeof e.timestamp === "string" && e.timestamp.length > 0, `${mode}: timestamp on ${e.event}`);
  }
  assert.equal(new Set(events.map((e) => e.run_id)).size, 1, `${mode}: one run id across all events`);
  for (const e of [...byType("step_start"), ...byType("step_end")]) {
    assert.ok(typeof e.step_kind === "string" && (e.step_kind as string).length > 0, `${mode}: step_kind present`);
    assert.ok(typeof e.step_name === "string" && (e.step_name as string).length > 0, `${mode}: step_name present`);
  }
  const scriptSteps = byType("step_end").map((e) => `${e.step_kind} ${e.step_name}`);
  assert.ok(scriptSteps.includes("script env_probe"), `${mode}: script step_end observed (saw: ${scriptSteps.join(", ")})`);
  const end = byType("run_end")[0];
  assert.equal(end.status, 0, `${mode}: run_end status 0 on success`);
  assert.ok(typeof end.elapsed_ms === "number", `${mode}: run_end elapsed_ms`);
}

test("hook contract: direct `jaiph run` dispatches all four events with the documented payloads", async () => {
  const { ws, fixture } = makeWorkspace(HOOK_FIXTURE);
  try {
    const hooksLog = writeHooksConfig(ws);
    // Project-local hooks are gated behind the per-workspace trust opt-in
    // (finding M-10); this contract exercises the trusted path.
    const outcome = runDirect(ws, fixture, [], cleanEnv({ JAIPH_TRUST_PROJECT_HOOKS: "1", HOOKS_LOG: hooksLog }));
    assert.equal(outcome.exitCode, 0, `run failed:\n${outcome.stderr}`);
    assertHookContract(await waitForHookEvents(hooksLog), fixture, ws, "run");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook contract: untrusted workspace does not run project-local hooks (finding M-10)", async () => {
  const { ws, fixture } = makeWorkspace(HOOK_FIXTURE);
  try {
    const hooksLog = writeHooksConfig(ws);
    // No JAIPH_TRUST_PROJECT_HOOKS: the project-local .jaiph/hooks.json must not
    // execute its host commands, so the hooks log is never created. The run
    // itself still succeeds (a hook gate never fails the workflow).
    const outcome = runDirect(ws, fixture, [], cleanEnv({ HOOKS_LOG: hooksLog }));
    assert.equal(outcome.exitCode, 0, `run should still succeed:\n${outcome.stderr}`);
    assert.equal(existsSync(hooksLog), false, "no hook command ran, so the log was never written");
    assert.match(
      outcome.stderr,
      /project-local hooks .* are ignored \(untrusted workspace\)/,
      "the CLI states why the project hooks were skipped and how to trust them",
    );
    assert.match(outcome.stderr, /JAIPH_TRUST_PROJECT_HOOKS=1/, "the notice names the opt-in");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook contract: HTTP `jaiph serve` runs dispatch the same four events", async () => {
  const { ws, fixture } = makeWorkspace(HOOK_FIXTURE);
  try {
    const hooksLog = writeHooksConfig(ws);
    const outcome = await runServeMode(ws, fixture, [], cleanEnv({ JAIPH_TRUST_PROJECT_HOOKS: "1", HOOKS_LOG: hooksLog }));
    assert.notEqual(outcome.exitCode, 1, `serve failed:\n${outcome.stderr}`);
    assertHookContract(await waitForHookEvents(hooksLog), fixture, ws, "serve");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook contract: MCP tool calls dispatch the same four events", async () => {
  const { ws, fixture } = makeWorkspace(HOOK_FIXTURE);
  try {
    const hooksLog = writeHooksConfig(ws);
    const outcome = await runMcpMode(ws, fixture, [], cleanEnv({ JAIPH_TRUST_PROJECT_HOOKS: "1", HOOKS_LOG: hooksLog }));
    assert.notEqual(outcome.exitCode, 1, `mcp failed:\n${outcome.stderr}`);
    assertHookContract(await waitForHookEvents(hooksLog), fixture, ws, "mcp");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
