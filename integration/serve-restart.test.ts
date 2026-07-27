import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

const FIXTURE = [
  "# Greets the given name.",
  "workflow greet(name) {",
  '  return "hi ${name}"',
  "}",
  "",
  "script long = `sleep 3`",
  "# Long enough to be caught mid-flight before a hard kill.",
  "workflow longflow() {",
  "  run long()",
  '  return "done"',
  "}",
  "",
].join("\n");

function serveEnv(runsRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_DOCKER_ENABLED: "false",
    JAIPH_RUNS_DIR: runsRoot,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

interface ServeProc {
  baseUrl: string;
  child: ChildProcess;
  stderr: () => string;
}

/** Spawn `jaiph serve --port 0` and resolve once it logs its bound URL. */
function startServe(fixture: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ServeProc> {
  const child = spawn("node", [CLI_PATH, "serve", "--port", "0", fixture], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start\nstderr:\n${stderrBuf}`)), 20_000);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/listening on (http:\/\/[^ ]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ baseUrl: m[1], child, stderr: () => stderrBuf });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (code ${code})\nstderr:\n${stderrBuf}`));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** SIGTERM then SIGKILL fallback; resolves once the process has exited. */
function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res();
    child.on("exit", () => res());
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 6_000).unref();
  });
}

async function getRun(baseUrl: string, id: string): Promise<any> {
  const res = await fetch(`${baseUrl}/v1/runs/${id}`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

test("jaiph serve: recovery + idempotency survive a real process restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-restart-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, FIXTURE);
  const runsRoot = join(root, ".jaiph/runs");

  const srv1 = await startServe(jh, root, serveEnv(runsRoot));
  let terminalId: string;
  let longId: string;
  try {
    // 1) A completed run with an idempotency key — the record we expect to
    //    reconstruct after restart.
    const created = await fetch(`${srv1.baseUrl}/v1/workflows/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-1" },
      body: JSON.stringify({ name: "world" }),
    });
    assert.equal(created.status, 200);
    const run = await created.json();
    assert.equal(run.status, "succeeded");
    assert.equal(run.result_text, "hi world");
    terminalId = run.run_id;

    // Space the next run into a distinct wall-clock second: run directories are
    // named `<HH-MM-SS>-<basename>`, so two runs in the same second would share
    // one directory (and one durable record).
    await delay(1200);

    // 2) A long run started async and left in flight, so a hard kill interrupts it.
    const longRes = await fetch(`${srv1.baseUrl}/v1/workflows/longflow/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(longRes.status, 202);
    longId = (await longRes.json()).run_id;
    // Wait until it is observably running (its run dir + journal exist).
    for (let i = 0; i < 40; i += 1) {
      const r = await getRun(srv1.baseUrl, longId);
      if (r.body?.status === "running" && r.body?.run_dir === null) {
        // run_dir is only set at finalize; a running record with a discoverable
        // journal is what we want. Break once the journal is on disk.
      }
      // Confirm the journal exists via the events endpoint resolving a dir.
      const ev = await fetch(`${srv1.baseUrl}/v1/runs/${longId}/events`);
      if (ev.status === 200 && (await ev.text()).includes("WORKFLOW_START")) break;
      await delay(100);
    }
  } finally {
    // Hard kill: SIGKILL bypasses graceful drain, leaving the long run's record
    // with no persisted terminal state — exactly a process-death interruption.
    await stop(srv1.child, "SIGKILL");
  }

  // 3) Restart on the same runs root.
  const srv2 = await startServe(jh, root, serveEnv(runsRoot));
  try {
    // (a) The pre-restart terminal run is fully reachable again.
    const reloaded = await getRun(srv2.baseUrl, terminalId);
    assert.equal(reloaded.status, 200, "GET works for a pre-restart terminal run");
    assert.equal(reloaded.body.status, "succeeded");
    assert.equal(reloaded.body.result_text, "hi world");

    // events + artifacts work for the reloaded run.
    const ev = await fetch(`${srv2.baseUrl}/v1/runs/${terminalId}/events`);
    assert.equal(ev.status, 200);
    const journal = readFileSync(join(reloaded.body.run_dir, "run_summary.jsonl"));
    assert.deepEqual(Buffer.from(await ev.arrayBuffer()), journal, "NDJSON events byte-match the journal after restart");
    const arts = await fetch(`${srv2.baseUrl}/v1/runs/${terminalId}/artifacts`);
    assert.equal(arts.status, 200);

    // (b) The interrupted run is reconciled out of `running`.
    const interrupted = await getRun(srv2.baseUrl, longId);
    assert.equal(interrupted.status, 200, "the interrupted run is still addressable");
    assert.equal(interrupted.body.status, "interrupted", "a run killed mid-flight is not permanently running");

    // (c) Idempotency survives: same key + same args returns the ORIGINAL run,
    //     spawning nothing new.
    const before = (await (await fetch(`${srv2.baseUrl}/v1/runs`)).json()).total;
    const replay = await fetch(`${srv2.baseUrl}/v1/workflows/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-1" },
      body: JSON.stringify({ name: "world" }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).run_id, terminalId, "same key + args returns the reconstructed original run");
    const after = (await (await fetch(`${srv2.baseUrl}/v1/runs`)).json()).total;
    assert.equal(after, before, "no new run was spawned by the idempotent replay");

    // (d) Same key + changed args is a conflict that never spawns.
    const conflict = await fetch(`${srv2.baseUrl}/v1/workflows/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-1" },
      body: JSON.stringify({ name: "changed" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "E_IDEMPOTENCY_CONFLICT");
    const afterConflict = (await (await fetch(`${srv2.baseUrl}/v1/runs`)).json()).total;
    assert.equal(afterConflict, before, "the conflicting request spawned nothing");
  } finally {
    await stop(srv2.child, "SIGTERM");
    // The orphaned `sleep 3` child from the interrupted run exits on its own.
    await delay(200);
    rmSync(root, { recursive: true, force: true });
  }
});
