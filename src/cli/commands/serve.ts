import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs } from "../shared/usage";
import { resolveEnvPairs } from "../run/env";
import { callWorkflow } from "../exec/call";
import {
  loadGeneration,
  createSourceWatcher,
  resolveStartupPosture,
  WATCH_INTERVAL_MS,
  type GenerationState,
} from "../shared/generation";
import { ServeHandler } from "../serve/handler";
import { createHttpServer, listen } from "../serve/server";
import { VERSION } from "../../version";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5247;
const DEFAULT_MAX_CONCURRENT = 4;

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
  "GET /v1/runs/{id}, POST /v1/runs/{id}/cancel.\n\n" +
  "Auth: set JAIPH_SERVE_TOKEN to require `Authorization: Bearer <token>` on every\n" +
  "/v1/* request (/healthz, /openapi.json, /docs stay open). Binding a non-loopback\n" +
  "host without the token set is a startup error. Cap concurrent runs with\n" +
  "JAIPH_SERVE_MAX_CONCURRENT (default 4).\n\n" +
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

/** One in-flight generation: its state, live-run refcount, and superseded flag. */
interface LiveGeneration {
  state: GenerationState;
  refs: number;
  superseded: boolean;
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

  // All logs go to stderr — stdout stays clean for scripting.
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-serve-"));
  let generation = 0;
  let current: LiveGeneration;
  try {
    const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph serve");
    if (!loaded.state) {
      for (const f of loaded.failures) log(f);
      rmSync(tempRoot, { recursive: true, force: true });
      return 1;
    }
    current = { state: loaded.state, refs: 0, superseded: false };
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  let dockerConfig: ReturnType<typeof resolveStartupPosture>["dockerConfig"];
  try {
    const posture = resolveStartupPosture(current.state, inputAbs, workspaceRoot, log);
    dockerConfig = posture.dockerConfig;
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

  // Delete a superseded generation's out dir only once its in-flight runs finish
  // — HTTP runs can outlive a reload (unlike MCP, where the client blocks).
  const maybeDeleteGeneration = (gen: LiveGeneration): void => {
    if (gen.superseded && gen.refs === 0) {
      rmSync(gen.state.callEnv.outDir, { recursive: true, force: true });
    }
  };

  // Track in-flight run promises so shutdown can drain them.
  const inFlightRuns = new Set<Promise<unknown>>();

  const handler = new ServeHandler({
    version: VERSION,
    serverTitle: `jaiph — ${basename(inputAbs)}`,
    token,
    maxConcurrent,
    now: () => new Date().toISOString(),
    getTools: () => current.state.tools,
    callTool: (spec, args, runId, ctx) => {
      // Bind the run to the generation live at start; keep its scripts dir alive
      // until the run finishes, then delete it if the generation was superseded.
      const gen = current;
      gen.refs += 1;
      const p = callWorkflow(
        gen.state.callEnv,
        dockerConfig,
        spec.workflow,
        spec.params.map((pp) => args[pp] ?? ""),
        runId,
        ctx,
      ).finally(() => {
        gen.refs -= 1;
        maybeDeleteGeneration(gen);
      });
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
      const prev = current;
      current = { state: loaded.state, refs: 0, superseded: false };
      watcher.rewatch([...current.state.graph.modules.keys()]);
      log(`jaiph serve: sources reloaded (${current.state.tools.length} workflow(s))`);
      prev.superseded = true;
      maybeDeleteGeneration(prev);
    } catch (err) {
      log(`jaiph serve: reload failed; keeping the previous workflows: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reloading = false;
    }
  };
  const watcher = createSourceWatcher(WATCH_INTERVAL_MS, onSourceChange);
  watcher.rewatch([...current.state.graph.modules.keys()]);

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
  log(`jaiph serve: listening on ${base} — API docs at ${base}/docs (${current.state.tools.length} workflow(s))`);

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
