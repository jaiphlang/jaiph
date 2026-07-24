import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { detectWorkspaceRoot } from "../shared/paths";
import { findRunDir } from "../shared/errors";
import { hasHelpFlag, parseArgs } from "../shared/usage";
import { resolveEnvPairs } from "../run/env";
import { callWorkflow, type OutputCaps } from "../exec/call";
import {
  loadGeneration,
  createGenerationTracker,
  createSourceWatcher,
  resolveStartupPosture,
  WATCH_INTERVAL_MS,
  type GenerationTracker,
} from "../shared/generation";
import { ServeHandler } from "../serve/handler";
import { createHttpServer, listen } from "../serve/server";
import { VERSION } from "../../version";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5247;
const DEFAULT_MAX_CONCURRENT = 4;
/** Keep the newest 500 completed runs resident; older terminal records evict. */
const DEFAULT_RETAIN_RUNS = 500;
/** Evict a completed run 24h after it ended (0 would disable age eviction). */
const DEFAULT_RETAIN_AGE_SEC = 24 * 60 * 60;
/** 1 MiB per stream / log buffer / result_text; bounds one run's memory. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** No cap on artifact downloads by default — they stream, so size costs no memory. */
const DEFAULT_MAX_ARTIFACT_BYTES = 0;

/**
 * Parse an integer env var, returning the fallback when unset. Throws a
 * diagnosable error (caught by the caller) when set but not an integer `>= min`.
 */
function intEnv(raw: string | undefined, name: string, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

const SERVE_USAGE =
  "Usage: jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>\n\n" +
  "Serve the file's workflows as an HTTP API with a generated OpenAPI 3.1 document\n" +
  "and an embedded Swagger UI. Anything that speaks HTTP can invoke tested workflows\n" +
  "and inspect their runs.\n\n" +
  "Exposure mirrors `jaiph mcp`: `export workflow` declarations if any exist, otherwise\n" +
  "every top-level workflow except channel route targets; `default` is exposed only\n" +
  "when it is the only workflow, named after the file's basename. Descriptions come\n" +
  "from the `#` comment lines above each workflow. Sources are re-validated on change.\n\n" +
  "Endpoints: GET /docs (Swagger UI), GET /openapi.json, GET /healthz, GET /v1/workflows,\n" +
  "POST /v1/workflows/{name}/runs (async 202 or ?wait=true for 200), GET /v1/runs,\n" +
  "GET /v1/runs/{id}, GET /v1/runs/{id}/events (NDJSON, or SSE with Accept: text/event-stream),\n" +
  "GET /v1/runs/{id}/artifacts, GET /v1/runs/{id}/artifacts/{path}, POST /v1/runs/{id}/cancel.\n\n" +
  "Auth: set JAIPH_SERVE_TOKEN to require `Authorization: Bearer <token>` on every\n" +
  "/v1/* request (/healthz, /openapi.json, /docs stay open). Binding a non-loopback\n" +
  "host without the token set is a startup error. Cap concurrent runs with\n" +
  "JAIPH_SERVE_MAX_CONCURRENT (default 4). Bound memory with JAIPH_SERVE_MAX_OUTPUT_BYTES\n" +
  "(per-run stdout/stderr/log/result cap, default 1 MiB), JAIPH_SERVE_RETAIN_RUNS\n" +
  "(completed runs kept in memory, default 500), and JAIPH_SERVE_RETAIN_AGE_SEC\n" +
  "(max completed-run age, default 86400; 0 disables). GET /v1/runs is paginated\n" +
  "(?limit default 100, max 1000; ?offset). Artifact downloads stream with\n" +
  "backpressure; JAIPH_SERVE_MAX_ARTIFACT_BYTES (default 0 = no cap) refuses\n" +
  "larger files with 413.\n\n" +
  "  --host <addr>      listen address (default: 127.0.0.1)\n" +
  "  --port <n>         listen port (default: 5247)\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  --env KEY=VALUE    define KEY in every run's env (repeatable); --env KEY forwards the host value.\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 ./tools.jh\n";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export async function runServe(rest: string[]): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(SERVE_USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { workspace, env, positional, host: hostArg, port: portArg } = parsed;
  const input = positional[0];
  if (!input) {
    process.stderr.write("jaiph serve requires a .jh file path\n");
    return 1;
  }
  let extraEnv: Record<string, string>;
  try {
    extraEnv = resolveEnvPairs(env, process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const inputAbs = resolve(input);
  if (!existsSync(inputAbs) || !statSync(inputAbs).isFile() || extname(inputAbs) !== ".jh") {
    process.stderr.write("jaiph serve expects a single .jh file\n");
    return 1;
  }
  const workspaceRoot = workspace ? resolve(workspace) : detectWorkspaceRoot(dirname(inputAbs));
  if (workspace && (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory())) {
    process.stderr.write(`--workspace path is not a directory: ${workspaceRoot}\n`);
    return 1;
  }

  const host = hostArg ?? DEFAULT_HOST;
  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--port must be an integer between 0 and 65535, got "${portArg}"\n`);
    return 1;
  }

  const token = process.env.JAIPH_SERVE_TOKEN;
  // Fail closed on exposure: a non-loopback bind without a token is a startup
  // error, before any socket is opened.
  if (!isLoopbackHost(host) && !token) {
    process.stderr.write(
      `jaiph serve: refusing to bind non-loopback host "${host}" without JAIPH_SERVE_TOKEN set ` +
        "(every /v1/* endpoint would be unauthenticated arbitrary shell). Set JAIPH_SERVE_TOKEN and retry.\n",
    );
    return 1;
  }

  const maxRaw = process.env.JAIPH_SERVE_MAX_CONCURRENT;
  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  if (maxRaw !== undefined) {
    const n = Number(maxRaw);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write(`JAIPH_SERVE_MAX_CONCURRENT must be a positive integer, got "${maxRaw}"\n`);
      return 1;
    }
    maxConcurrent = n;
  }

  // Memory bounds: retained completed runs (count + age) and per-run output caps.
  let retainRuns: number;
  let retainAgeSec: number;
  let maxOutputBytes: number;
  let maxArtifactBytes: number;
  try {
    retainRuns = intEnv(process.env.JAIPH_SERVE_RETAIN_RUNS, "JAIPH_SERVE_RETAIN_RUNS", DEFAULT_RETAIN_RUNS, 1);
    retainAgeSec = intEnv(process.env.JAIPH_SERVE_RETAIN_AGE_SEC, "JAIPH_SERVE_RETAIN_AGE_SEC", DEFAULT_RETAIN_AGE_SEC, 0);
    maxOutputBytes = intEnv(process.env.JAIPH_SERVE_MAX_OUTPUT_BYTES, "JAIPH_SERVE_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES, 1);
    maxArtifactBytes = intEnv(process.env.JAIPH_SERVE_MAX_ARTIFACT_BYTES, "JAIPH_SERVE_MAX_ARTIFACT_BYTES", DEFAULT_MAX_ARTIFACT_BYTES, 0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const outputCaps: OutputCaps = {
    stdout: maxOutputBytes,
    stderr: maxOutputBytes,
    logs: maxOutputBytes,
    resultText: maxOutputBytes,
  };

  // All logs go to stderr — stdout stays clean for scripting.
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-serve-"));
  let generation = 0;
  let generations: GenerationTracker;
  try {
    const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph serve");
    if (!loaded.state) {
      for (const f of loaded.failures) log(f);
      rmSync(tempRoot, { recursive: true, force: true });
      return 1;
    }
    generations = createGenerationTracker(loaded.state);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  let dockerConfig: ReturnType<typeof resolveStartupPosture>["dockerConfig"];
  let hostRunsRoot: string;
  try {
    const posture = resolveStartupPosture(generations.current(), inputAbs, workspaceRoot, log);
    dockerConfig = posture.dockerConfig;
    hostRunsRoot = posture.hostRunsRoot;
    if (dockerConfig.enabled) {
      if (posture.sandboxMode === "inplace") {
        log(
          `jaiph serve: runs execute in a Docker sandbox in-place on ${workspaceRoot} ` +
            "(JAIPH_INPLACE=1 opt-in: effects land live on the workspace).",
        );
      } else {
        log(`jaiph serve: runs execute in a Docker sandbox (${posture.sandboxMode} mode; workspace isolated).`);
      }
    } else {
      log("jaiph serve: runs execute on the host with no sandbox.");
    }
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  // Track in-flight run promises so shutdown can drain them.
  const inFlightRuns = new Set<Promise<unknown>>();

  const handler = new ServeHandler({
    version: VERSION,
    serverTitle: `jaiph — ${basename(inputAbs)}`,
    token,
    maxConcurrent,
    retainRuns,
    retainAgeSec,
    maxArtifactBytes,
    now: () => new Date().toISOString(),
    // A run's dir is only recorded on its object at finalize; while it runs the
    // events/artifacts endpoints locate it by scanning the host runs root for
    // the run id (works host- and Docker-side — the run dir is a host mount).
    // The handler caches the first hit per record, so a live SSE poll loop
    // scans at most once.
    resolveRunDir: (record) => findRunDir(hostRunsRoot, record.run_id),
    getTools: () => generations.current().tools,
    callTool: (spec, args, runId, ctx) => {
      // Bind the run to the generation live at start; the lease keeps its
      // scripts dir alive until the run finishes (deleted then if superseded).
      const lease = generations.acquire();
      const p = callWorkflow(
        lease.state.callEnv,
        dockerConfig,
        spec.workflow,
        spec.params.map((pp) => args[pp] ?? ""),
        runId,
        ctx,
        outputCaps,
      ).finally(() => lease.release());
      const tracked = p.then(
        () => undefined,
        () => undefined,
      );
      inFlightRuns.add(tracked);
      void tracked.finally(() => inFlightRuns.delete(tracked));
      return p;
    },
  });

  // Hot reload: swap the current generation; per-request OpenAPI + tool reads
  // pick it up with no cache to invalidate. Validation failures keep serving.
  let reloading = false;
  const onSourceChange = (): void => {
    if (reloading) return;
    reloading = true;
    try {
      generation += 1;
      const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph serve");
      if (!loaded.state) {
        log("jaiph serve: reload failed; keeping the previous workflows:");
        for (const f of loaded.failures) log(`  ${f}`);
        return;
      }
      generations.swap(loaded.state);
      watcher.rewatch([...loaded.state.graph.modules.keys()]);
      log(`jaiph serve: sources reloaded (${loaded.state.tools.length} workflow(s))`);
    } catch (err) {
      log(`jaiph serve: reload failed; keeping the previous workflows: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reloading = false;
    }
  };
  const watcher = createSourceWatcher(WATCH_INTERVAL_MS, onSourceChange);
  watcher.rewatch([...generations.current().graph.modules.keys()]);

  const httpServer = createHttpServer(handler, log);
  let boundPort: number;
  try {
    boundPort = await listen(httpServer, host, port);
  } catch (err) {
    log(`jaiph serve: failed to listen on ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`);
    watcher.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  const base = `http://${host}:${boundPort}`;
  log(`jaiph serve: listening on ${base} — API docs at ${base}/docs (${generations.current().tools.length} workflow(s))`);
  log(
    `jaiph serve: memory bounds — retain ${retainRuns} completed run(s)` +
      `${retainAgeSec > 0 ? ` up to ${retainAgeSec}s old` : ""}, ${maxOutputBytes} output bytes/run; ` +
      "durable .jaiph/runs artifacts are pruned separately (operator responsibility).",
  );

  return await new Promise<number>((resolveExit) => {
    let draining = false;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      watcher.stop();
      httpServer.close();
      rmSync(tempRoot, { recursive: true, force: true });
      resolveExit(code);
    };
    const onSignal = (): void => {
      if (!draining) {
        draining = true;
        log("jaiph serve: shutting down; draining in-flight runs (signal again to cancel them)...");
        httpServer.close();
        watcher.stop();
        void Promise.allSettled([...inFlightRuns]).then(() => finish(0));
      } else {
        log("jaiph serve: cancelling in-flight runs...");
        handler.cancelAll();
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
