import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

const BASE_FIXTURE = [
  "script sleeper = `sleep 1`",
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
  "# Sleeps briefly, then returns.",
  "workflow slow() {",
  "  run sleeper()",
  '  return "woke"',
  "}",
  "",
  "script step_one = `sleep 0.4; echo one`",
  "script step_two = `sleep 0.4; echo two`",
  "# Two slow steps so a STEP_END is observable before the run is terminal.",
  "workflow watchable() {",
  "  run step_one()",
  "  run step_two()",
  '  return "watched"',
  "}",
  "",
  'script leak = `echo "token is $LEAK_API_KEY"`',
  "# Echoes a credential value to stdout to exercise journal redaction.",
  "workflow leak_secret() {",
  "  run leak()",
  '  return "done"',
  "}",
  "",
  'script publish = `printf \'artifact-payload\' > "$JAIPH_ARTIFACTS_DIR/result.txt"`',
  "# Publishes a file into the run's artifacts dir.",
  "workflow make_artifact() {",
  "  run publish()",
  '  return "published"',
  "}",
  "",
].join("\n");

function serveEnv(runsRoot: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAIPH_DOCKER_ENABLED: "false",
    JAIPH_RUNS_DIR: runsRoot,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

interface ServeProc {
  baseUrl: string;
  stderr: () => string;
  close: () => Promise<void>;
}

/** Spawn `jaiph serve --port 0`, resolving once it logs its bound listen URL. */
function startServe(fixture: string, cwd: string, env: NodeJS.ProcessEnv, extraArgv: string[] = []): Promise<ServeProc> {
  const child = spawn("node", [CLI_PATH, "serve", "--port", "0", ...extraArgv, fixture], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start\nstderr:\n${stderrBuf}`)), 20_000);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/listening on (http:\/\/[^ ]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({
          baseUrl: m[1],
          stderr: () => stderrBuf,
          close: () =>
            new Promise<void>((res) => {
              child.on("exit", () => res());
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollRun(baseUrl: string, id: string, timeoutMs = 20_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${baseUrl}/v1/runs/${id}`);
    assert.equal(res.status, 200);
    const run = await res.json();
    if (run.status !== "running") return run;
    if (Date.now() - start > timeoutMs) throw new Error(`run ${id} did not finish; last=${JSON.stringify(run)}`);
    await delay(150);
  }
}

test("jaiph serve: wait=true round-trips a workflow return value as succeeded", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-wait-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    const res = await fetch(`${srv.baseUrl}/v1/workflows/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "world" }),
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, "succeeded");
    assert.equal(run.result_text, "hello world");
    assert.ok(run.run_dir && existsSync(join(run.run_dir, "run_summary.jsonl")), "run dir has run_summary.jsonl");
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: async POST returns 202 + Location and polling reaches the same terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-async-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    const res = await fetch(`${srv.baseUrl}/v1/workflows/greet/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "async" }),
    });
    assert.equal(res.status, 202);
    const location = res.headers.get("location");
    const started = await res.json();
    assert.equal(started.status, "running");
    assert.equal(location, `/v1/runs/${started.run_id}`);

    const run = await pollRun(srv.baseUrl, started.run_id);
    assert.equal(run.status, "succeeded");
    assert.equal(run.result_text, "hello async");
    assert.ok(existsSync(join(run.run_dir, "run_summary.jsonl")), "durable run_summary.jsonl exists");
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: a failing workflow is HTTP 200 with status failed (not an HTTP error)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-fail-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    const res = await fetch(`${srv.baseUrl}/v1/workflows/boom/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200, "workflow failure must not be an HTTP error");
    const run = await res.json();
    assert.equal(run.status, "failed");
    assert.equal(typeof run.exit_status, "number");
    assert.notEqual(run.exit_status, 0);
    assert.match(run.result_text, /failed step/);
    assert.match(run.result_text, /run dir:/);
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: hot reload surfaces a new workflow and a pre-reload run still completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-reload-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    // Start a slow run against the current generation, then reload.
    const startRes = await fetch(`${srv.baseUrl}/v1/workflows/slow/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 202);
    const slowId = (await startRes.json()).run_id;

    // Add a workflow; the watcher reloads without a restart.
    writeFileSync(jh, `${BASE_FIXTURE}\n# A freshly added tool.\nworkflow extra() {\n  return "extra"\n}\n`);

    const start = Date.now();
    for (;;) {
      const doc = await (await fetch(`${srv.baseUrl}/openapi.json`)).json();
      if (doc.paths["/v1/workflows/extra/runs"]) break;
      if (Date.now() - start > 15_000) throw new Error("reload did not surface the new workflow in /openapi.json");
      await delay(200);
    }
    const wf = await (await fetch(`${srv.baseUrl}/v1/workflows`)).json();
    assert.ok(wf.workflows.some((w: any) => w.name === "extra"), "/v1/workflows lists the new workflow");

    // The run started before the reload still finishes successfully (its
    // generation's scripts dir survives until it completes — refcounted).
    const run = await pollRun(srv.baseUrl, slowId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.result_text, "woke");
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: with a token, /v1/* needs the bearer while /healthz, /openapi.json, /docs stay open", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-auth-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs"), { JAIPH_SERVE_TOKEN: "s3cret" }));
  try {
    assert.equal((await fetch(`${srv.baseUrl}/v1/workflows`)).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/v1/workflows`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/v1/workflows`, { headers: { authorization: "Bearer s3cret" } })).status, 200);

    for (const path of ["/healthz", "/openapi.json", "/docs"]) {
      assert.equal((await fetch(`${srv.baseUrl}${path}`)).status, 200, `${path} is open without a token`);
    }
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: binding a non-loopback host without JAIPH_SERVE_TOKEN exits 1 before listening", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-noloop-"));
  try {
    const jh = join(root, "tools.jh");
    writeFileSync(jh, BASE_FIXTURE);
    const env = serveEnv(join(root, ".jaiph/runs"));
    delete env.JAIPH_SERVE_TOKEN;
    const result = spawnSync("node", [CLI_PATH, "serve", "--host", "0.0.0.0", "--port", "0", jh], {
      encoding: "utf8",
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stderr}`);
    assert.match(result.stderr, /JAIPH_SERVE_TOKEN/);
    assert.doesNotMatch(result.stderr, /listening on/, "must not bind before failing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Extract the journal `data:` payloads (one per journal line) from an SSE
 * buffer. The terminating `event: end\ndata: {}` frame is excluded — only the
 * replayed/followed journal lines are returned.
 */
function sseDataLines(sse: string): string[] {
  return sse
    .split("event: end")[0]
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));
}

test("jaiph serve: SSE events replay WORKFLOW_START, stream a STEP_END mid-run, then close on event: end", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-sse-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    // Start async, then connect the event stream while the run is still going.
    const startRes = await fetch(`${srv.baseUrl}/v1/workflows/watchable/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 202);
    const runId = (await startRes.json()).run_id;

    const evRes = await fetch(`${srv.baseUrl}/v1/runs/${runId}/events`, { headers: { accept: "text/event-stream" } });
    assert.equal(evRes.status, 200);
    assert.match(evRes.headers.get("content-type") ?? "", /text\/event-stream/);

    // Read the stream to completion (the server closes after `event: end`).
    const reader = evRes.body!.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sse += decoder.decode(value, { stream: true });
      if (sse.includes("event: end")) break;
    }

    const dataLines = sseDataLines(sse);
    const events = dataLines.map((l) => JSON.parse(l));
    // (a) the replayed WORKFLOW_START is present.
    assert.ok(events.some((e) => e.type === "WORKFLOW_START"), "WORKFLOW_START replayed");
    // (b) a STEP_END arrived, and it precedes the terminating `event: end`.
    const stepEndIdx = sse.indexOf('"type":"STEP_END"');
    const endIdx = sse.indexOf("event: end");
    assert.ok(stepEndIdx !== -1, "at least one STEP_END streamed");
    assert.ok(stepEndIdx < endIdx, "STEP_END arrived before the run went terminal");
    // (c) the stream closed with event: end.
    assert.match(sse, /event: end/);

    // (d) the concatenated data payloads equal the final run_summary.jsonl line set.
    const run = await pollRun(srv.baseUrl, runId);
    assert.equal(run.status, "succeeded");
    const journalLines = readFileSync(join(run.run_dir, "run_summary.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(dataLines, journalLines, "SSE data payloads match the journal exactly");
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: NDJSON events on a terminal run byte-match the journal; unknown run → 404, unauthenticated → 401", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-ndjson-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  // A token so the 401 path is exercised.
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs"), { JAIPH_SERVE_TOKEN: "t0ken" }));
  const auth = { authorization: "Bearer t0ken" };
  try {
    const runRes = await fetch(`${srv.baseUrl}/v1/workflows/greet/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ name: "nd" }),
    });
    const run = await runRes.json();
    assert.equal(run.status, "succeeded");

    const ev = await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/events`, { headers: auth });
    assert.equal(ev.status, 200);
    assert.match(ev.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const body = Buffer.from(await ev.arrayBuffer());
    assert.deepEqual(body, readFileSync(join(run.run_dir, "run_summary.jsonl")), "NDJSON is byte-identical to the journal");

    // Unknown run id → 404.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/does-not-exist/events`, { headers: auth })).status, 404);
    // Unauthenticated → 401.
    assert.equal((await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/events`)).status, 401);
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: a credential echoed by a run is [REDACTED] in the event stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-redact-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const secret = "supersecretvalue123";
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")), ["--env", `LEAK_API_KEY=${secret}`]);
  try {
    const runRes = await fetch(`${srv.baseUrl}/v1/workflows/leak_secret/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const run = await runRes.json();
    assert.equal(run.status, "succeeded", `run failed: ${JSON.stringify(run)}`);

    const ev = await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/events`);
    const journal = await ev.text();
    assert.ok(!journal.includes(secret), "the raw credential value must not appear in the event stream");
    assert.ok(journal.includes("[REDACTED]"), "the redaction marker is present where the value was");
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph serve: artifacts round-trip — list then byte-identical download, traversal is 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-serve-art-"));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, BASE_FIXTURE);
  const srv = await startServe(jh, root, serveEnv(join(root, ".jaiph/runs")));
  try {
    const runRes = await fetch(`${srv.baseUrl}/v1/workflows/make_artifact/runs?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const run = await runRes.json();
    assert.equal(run.status, "succeeded", `run failed: ${JSON.stringify(run)}`);

    const list = await (await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/artifacts`)).json();
    assert.deepEqual(
      list.artifacts.map((a: any) => a.path),
      ["result.txt"],
      "the published file is listed",
    );

    const dl = await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/artifacts/result.txt`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-type") ?? "", /application\/octet-stream/);
    assert.match(dl.headers.get("content-disposition") ?? "", /filename="result\.txt"/);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString("utf8"), "artifact-payload");

    // Traversal battery: encoded `..`, `%2e%2e`, and an absolute path all 404,
    // and the run's own run_summary.jsonl (outside artifacts/) is unreachable.
    for (const escape of ["..%2Frun_summary.jsonl", "%2e%2e%2frun_summary.jsonl", "%2Fetc%2Fpasswd"]) {
      const res = await fetch(`${srv.baseUrl}/v1/runs/${run.run_id}/artifacts/${escape}`);
      assert.equal(res.status, 404, `traversal ${escape} → 404`);
    }
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph --help lists jaiph serve", () => {
  const result = spawnSync("node", [CLI_PATH, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /jaiph serve/);
});
