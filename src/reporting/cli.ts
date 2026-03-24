import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultRunsRoot, resolveRunsRoot } from "./path-utils";
import { startReportingServer } from "./report-server";

type ReportCommand = "start" | "stop" | "status";

function parseReportArgs(argv: string[]): {
  command: ReportCommand;
  host: string;
  port: number;
  pollMs: number;
  cwd: string;
  runsDir?: string;
  pidFile?: string;
} {
  let command: ReportCommand = "start";
  let host = process.env.JAIPH_REPORT_HOST ?? "127.0.0.1";
  let port = parseInt(process.env.JAIPH_REPORT_PORT ?? "8787", 10);
  let pollMs = parseInt(process.env.JAIPH_REPORT_POLL_MS ?? "500", 10);
  let cwd = process.cwd();
  let runsDir: string | undefined = process.env.JAIPH_REPORT_RUNS_DIR;
  let pidFile: string | undefined = process.env.JAIPH_REPORT_PID_FILE;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === "start" || a === "stop" || a === "status") && command === "start") {
      command = a;
      continue;
    }
    if (a === "--host" && argv[i + 1]) {
      host = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--port" && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (a === "--poll-ms" && argv[i + 1]) {
      pollMs = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (a === "--runs-dir" && argv[i + 1]) {
      runsDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--workspace" && argv[i + 1]) {
      cwd = resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === "--pid-file" && argv[i + 1]) {
      pidFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: jaiph report [start|stop|status] [options]",
          "",
          "Serve a read-only dashboard over .jaiph/runs (run_summary.jsonl + artifacts).",
          "",
          "Commands:",
          "  start              Start server in foreground (default)",
          "  stop               Stop server recorded in pid file",
          "  status             Show whether recorded server is running",
          "",
          "Options:",
          "  --host <addr>       Bind address (default 127.0.0.1)",
          "  --port <n>          Port (default 8787)",
          "  --poll-ms <n>       Summary tail interval in ms (default 500)",
          "  --runs-dir <path>   Runs root (default <workspace>/.jaiph/runs)",
          "  --workspace <path>  Project root for default runs dir (default cwd)",
          "  --pid-file <path>   Pid file (default <workspace>/.jaiph/report.pid)",
          "  -h, --help          Show this help",
          "",
          "Environment: JAIPH_REPORT_HOST, JAIPH_REPORT_PORT, JAIPH_REPORT_POLL_MS, JAIPH_REPORT_RUNS_DIR, JAIPH_REPORT_PID_FILE",
          "",
        ].join("\n"),
      );
      return { command, host, port, pollMs, cwd, runsDir, pidFile };
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port`);
  }
  if (!Number.isFinite(pollMs) || pollMs < 50) {
    throw new Error(`Invalid --poll-ms (min 50)`);
  }
  return { command, host, port, pollMs, cwd, runsDir, pidFile };
}

function resolvePidFile(cwd: string, explicit?: string): string {
  return resolve(cwd, explicit ?? ".jaiph/report.pid");
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) {
    return null;
  }
  const raw = readFileSync(pidFile, "utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof obj.pid === "number" ? obj.pid : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) {
      return true;
    }
    await wait(100);
  }
  return !isAlive(pid);
}

export async function runReportingCli(argv: string[]): Promise<number> {
  const opts = parseReportArgs(argv);
  const pidFile = resolvePidFile(opts.cwd, opts.pidFile);
  if (argv.includes("--help") || argv.includes("-h")) {
    return 0;
  }

  if (opts.command === "status") {
    const pid = readPid(pidFile);
    if (pid && isAlive(pid)) {
      process.stdout.write(`jaiph report is running (pid ${pid})\n`);
      return 0;
    }
    process.stdout.write("jaiph report is not running\n");
    return 1;
  }

  if (opts.command === "stop") {
    const pid = readPid(pidFile);
    if (!pid) {
      process.stdout.write("jaiph report is not running\n");
      return 1;
    }
    if (!isAlive(pid)) {
      rmSync(pidFile, { force: true });
      process.stdout.write("jaiph report was not running (removed stale pid file)\n");
      return 1;
    }
    process.kill(pid, "SIGTERM");
    const exited = await waitForExit(pid, 4000);
    if (!exited) {
      process.kill(pid, "SIGKILL");
      await waitForExit(pid, 1000);
    }
    rmSync(pidFile, { force: true });
    process.stdout.write(`stopped jaiph report (pid ${pid})\n`);
    return 0;
  }

  const existingPid = readPid(pidFile);
  if (existingPid && isAlive(existingPid)) {
    throw new Error(`jaiph report already running (pid ${existingPid}); use 'jaiph report stop'`);
  }
  if (existingPid) {
    rmSync(pidFile, { force: true });
  }

  const runsRoot = resolveRunsRoot(opts.cwd, opts.runsDir);
  if (!existsSync(runsRoot)) {
    process.stderr.write(`Note: runs directory does not exist yet (${runsRoot}); the UI will stay empty until runs appear.\n`);
  }
  const publicDir = resolve(__dirname, "public");
  if (!existsSync(publicDir)) {
    throw new Error(`Missing static assets: ${publicDir} (build/copy step)`);
  }
  const server = startReportingServer({
    host: opts.host,
    port: opts.port,
    runsRoot,
    pollMs: opts.pollMs,
    publicDir,
  });
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(
    pidFile,
    JSON.stringify({ pid: process.pid, host: opts.host, port: opts.port, runsRoot, started_at: new Date().toISOString() }),
  );
  process.stderr.write(`PID file: ${pidFile}\n`);
  const signal = await new Promise<"SIGINT" | "SIGTERM">((resolveSignal) => {
    process.once("SIGINT", () => resolveSignal("SIGINT"));
    process.once("SIGTERM", () => resolveSignal("SIGTERM"));
  });
  process.stderr.write(`\nStopping reporting server (${signal})...\n`);
  await server.close();
  rmSync(pidFile, { force: true });
  return 0;
}

if (require.main === module) {
  runReportingCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    });
}
