import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("jaiph --help lists jaiph serve", () => {
  const result = spawnSync("node", [CLI_PATH, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /jaiph serve/);
});
