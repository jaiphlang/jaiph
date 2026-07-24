import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

interface FakeSentry {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** A minimal fake Sentry ingest that records every envelope and replies `status`. */
function startSentry(status = 200): Promise<FakeSentry> {
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
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
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
 * the in-process fake Sentry must accept the envelope connection while the run
 * is in flight (spawnSync would block the loop and deadlock it).
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
    // Ensure a stray host DSN never leaks into the no-DSN baseline cases.
    SENTRY_DSN: "",
  };
}

/** A workflow whose one step fails with a nonzero exit, so the run fails. */
const FAIL_FIXTURE = ['script boom = `echo "step output"; exit 3`', "workflow default() {", "  run boom()", "}", ""].join("\n");

/** A workflow that succeeds. */
const OK_FIXTURE = ['script ok = `echo "hi"`', "workflow default() {", "  run ok()", '  return "done"', "}", ""].join("\n");

function sentryWarnings(stderr: string): string[] {
  return stderr.split("\n").filter((l) => l.includes("Sentry error report"));
}

function dsn(port: number): string {
  return `http://pubkey@127.0.0.1:${port}/7`;
}

test("jaiph run: a failed run with SENTRY_DSN delivers exactly one envelope carrying the failing step + excerpt", async () => {
  const sentry = await startSentry(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-fail-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, FAIL_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: { ...baseEnv(join(root, ".jaiph/runs")), SENTRY_DSN: dsn(sentry.port), SENTRY_ENVIRONMENT: "ci" },
    });
    assert.notEqual(result.status, 0, "the run itself fails");
    assert.equal(sentry.requests.length, 1, "exactly one envelope POST");

    const req = sentry.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/7/envelope/", "DSN project id maps to the envelope endpoint");
    assert.equal(req.headers["content-type"], "application/x-sentry-envelope");
    assert.match(String(req.headers["x-sentry-auth"]), /^Sentry sentry_version=7, sentry_key=pubkey, sentry_client=jaiph\//);

    const docs = req.body.split("\n");
    assert.equal(docs.length, 3, "envelope header + item header + event");
    const header = JSON.parse(docs[0]) as { event_id: string; sent_at: string };
    assert.match(header.event_id, /^[0-9a-f]{32}$/);
    assert.deepEqual(JSON.parse(docs[1]), { type: "event" });

    const event = JSON.parse(docs[2]) as {
      event_id: string;
      level: string;
      message: { formatted: string };
      tags: Record<string, string>;
      extra: Record<string, string>;
      fingerprint: string[];
      environment?: string;
    };
    assert.equal(event.event_id, header.event_id);
    assert.equal(event.level, "error");
    assert.equal(event.message.formatted, "workflow default failed (exit 3)");
    assert.equal(event.tags["jaiph.workflow"], "default");
    assert.equal(event.tags["jaiph.source"], "app.jh");
    assert.equal(event.tags["jaiph.step.name"], "boom", "failing step tag present");
    assert.equal(event.tags["jaiph.step.kind"], "script");
    assert.equal(event.extra.failing_step_detail, "step output", "the failing step's redacted excerpt");
    assert.ok(event.extra.run_dir && event.extra.run_dir.length > 0, "run dir pointer present");
    assert.deepEqual(event.fingerprint, ["jaiph", "default", "boom"]);
    assert.equal(event.environment, "ci");
  } finally {
    await sentry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: a succeeding run with SENTRY_DSN delivers nothing", async () => {
  const sentry = await startSentry(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-ok-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, OK_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: { ...baseEnv(join(root, ".jaiph/runs")), SENTRY_DSN: dsn(sentry.port) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sentry.requests.length, 0, "successful runs send nothing");
    assert.equal(sentryWarnings(result.stderr).length, 0);
  } finally {
    await sentry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: a failed run WITHOUT SENTRY_DSN delivers nothing", async () => {
  const sentry = await startSentry(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-nodsn-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, FAIL_FIXTURE);
    const result = await runCli(["run", jh], { cwd: root, env: baseEnv(join(root, ".jaiph/runs")) });
    assert.notEqual(result.status, 0, "the run itself fails");
    assert.equal(sentry.requests.length, 0, "no DSN → no send");
    assert.equal(sentryWarnings(result.stderr).length, 0);
  } finally {
    await sentry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Failure isolation: exit code unchanged from the no-DSN baseline -------

/** The failing run's exit code with Sentry disabled — the isolation reference. */
async function noDsnBaselineStatus(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-baseline-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, FAIL_FIXTURE);
    const result = await runCli(["run", jh], { cwd: root, env: baseEnv(join(root, ".jaiph/runs")) });
    return result.status;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("jaiph run: a Sentry 500 keeps the exit code at the no-DSN baseline and prints exactly one warning", async () => {
  const baseline = await noDsnBaselineStatus();
  const sentry = await startSentry(500);
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-500-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, FAIL_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: { ...baseEnv(join(root, ".jaiph/runs")), SENTRY_DSN: dsn(sentry.port) },
    });
    assert.equal(result.status, baseline, "telemetry is never load-bearing");
    assert.equal(sentry.requests.length, 1, "one envelope was attempted");
    const warns = sentryWarnings(result.stderr);
    assert.equal(warns.length, 1, `exactly one warning line, got: ${result.stderr}`);
    assert.match(warns[0], /HTTP 500/);
  } finally {
    await sentry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run: a refused Sentry keeps the exit code at the no-DSN baseline and prints exactly one warning", async () => {
  const baseline = await noDsnBaselineStatus();
  const port = await reservedClosedPort();
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-refused-"));
  try {
    const jh = join(root, "app.jh");
    writeFileSync(jh, FAIL_FIXTURE);
    const result = await runCli(["run", jh], {
      cwd: root,
      env: { ...baseEnv(join(root, ".jaiph/runs")), SENTRY_DSN: dsn(port) },
    });
    assert.equal(result.status, baseline, "a refused connection never changes the exit code");
    const warns = sentryWarnings(result.stderr);
    assert.equal(warns.length, 1, `exactly one warning line, got: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: a credential in the failing step's output reaches the event only as [REDACTED]", async () => {
  const sentry = await startSentry(200);
  const root = mkdtempSync(join(tmpdir(), "jaiph-sentry-redact-"));
  const SECRET = "supersecretvalue";
  try {
    const jh = join(root, "app.jh");
    writeFileSync(
      jh,
      ['script leak = `printf %s "$SECRET_API_KEY"; exit 1`', "workflow default() {", "  run leak()", "}", ""].join("\n"),
    );
    const result = await runCli(["run", jh], {
      cwd: root,
      env: { ...baseEnv(join(root, ".jaiph/runs")), SECRET_API_KEY: SECRET, SENTRY_DSN: dsn(sentry.port) },
    });
    assert.notEqual(result.status, 0, "the run itself fails");
    assert.equal(sentry.requests.length, 1);
    const body = sentry.requests[0].body;
    assert.equal(body.includes(SECRET), false, "raw credential must never appear in the event");
    assert.ok(body.includes("[REDACTED]"), "the redacted marker flows through from the journal");
  } finally {
    await sentry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
