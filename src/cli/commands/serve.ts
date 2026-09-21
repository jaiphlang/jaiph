import { basename } from "node:path";
import { errText } from "../../errors";
import { findRunDir } from "../shared/errors";
import { callDef, type OutputCaps } from "../shared/workflow-call";
import { parseServerArgs, startGeneration, startReloadWatcher } from "../shared/serve-bootstrap";
import { createOperatorLog } from "../shared/server-log";
import {
  ServeHandler,
  createAuthenticator,
  loadPersistedRuns,
  persistRunRecord,
  createHttpServer,
  listen,
  type AuthConfig,
} from "../serve";
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
  "Usage: jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--allow-anonymous] [--env KEY[=VALUE]]... <file.jh>\n\n" +
  "Serve the file's defs as an HTTP API with a generated OpenAPI 3.1 document\n" +
  "and an embedded Swagger UI. Anything that speaks HTTP can invoke tested workflows\n" +
  "and inspect their runs.\n\n" +
  "Exposure mirrors `jaiph mcp`: exported defs only; `main` is exposed only\n" +
  "when it is the only export, named after the file's basename. Descriptions come\n" +
  "from the `#` comment lines above each def. Sources are re-validated on change.\n\n" +
  "Endpoints: GET /docs (self-contained Swagger UI — assets embedded, no browser internet\n" +
  "access needed), GET /openapi.json, GET /healthz, GET /defs,\n" +
  "POST /{name} (async 202 or ?wait=true for 200), GET /runs,\n" +
  "GET /runs/{id}, GET /runs/{id}/events (NDJSON, or SSE with Accept: text/event-stream),\n" +
  "GET /runs/{id}/artifacts, GET /runs/{id}/artifacts/{path}, POST /runs/{id}/cancel.\n" +
  "MCP clients: POST /mcp speaks MCP Streamable HTTP over the same workflows, run\n" +
  "registry, concurrency cap, and auth — the network sibling of `jaiph mcp` stdio.\n\n" +
  "Auth is off by default (same as `jaiph mcp` stdio): every REST and /mcp caller is the\n" +
  "anonymous principal with all capabilities over all runs. Set JAIPH_SERVE_TOKEN for a static\n" +
  "single-operator bearer on every REST and /mcp request — single-operator, not multi-tenant.\n" +
  "For per-user identity and authorization, configure OIDC/JWT with JAIPH_SERVE_OIDC_ISSUER +\n" +
  "JAIPH_SERVE_OIDC_AUDIENCE (JWKS discovered from the issuer, or set JAIPH_SERVE_OIDC_JWKS_URI).\n" +
  "OIDC tokens are authorized by scope — jaiph:invoke (run), jaiph:inspect (read runs/artifacts),\n" +
  "jaiph:cancel — and a principal may inspect/cancel only its own runs. /healthz is always open\n" +
  "and credential-free; /docs and /openapi.json are open unless JAIPH_SERVE_EXPOSE_DOCS=false.\n" +
  "--allow-anonymous is only required to bind a non-loopback address with no token and no OIDC\n" +
  "(Docker must listen on 0.0.0.0). Shared or network-exposed hosts should set JAIPH_SERVE_TOKEN\n" +
  "or configure OIDC.\n" +
  "Cap concurrent runs with\n" +
  "JAIPH_SERVE_MAX_CONCURRENT (default 4). Bound memory with JAIPH_SERVE_MAX_OUTPUT_BYTES\n" +
  "(per-run stdout/stderr/log/result cap, default 1 MiB), JAIPH_SERVE_RETAIN_RUNS\n" +
  "(completed runs kept in memory, default 500), and JAIPH_SERVE_RETAIN_AGE_SEC\n" +
  "(max completed-run age, default 86400; 0 disables). GET /runs is paginated\n" +
  "(?limit default 100, max 1000; ?offset). Artifact downloads stream with\n" +
  "backpressure; JAIPH_SERVE_MAX_ARTIFACT_BYTES (default 0 = no cap) refuses\n" +
  "larger files with 413.\n\n" +
  "  --host <addr>      listen address (default: 127.0.0.1)\n" +
  "  --port <n>         listen port (default: 5247)\n" +
  "  --allow-anonymous  bind a non-loopback address with no auth (default bind is already\n" +
  "                     open). Ignored when JAIPH_SERVE_TOKEN or OIDC is set.\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  --env KEY=VALUE    grant KEY to matching `use` clauses on every run (repeatable); --env KEY forwards the host value.\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 ./tools.jh\n";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export async function runServe(rest: string[]): Promise<number> {
  const pre = parseServerArgs("serve", rest, SERVE_USAGE);
  if ("code" in pre) return pre.code;
  const { parsed, log } = pre.args;
  const { host: hostArg, port: portArg, allowAnonymous } = parsed;

  const host = hostArg ?? DEFAULT_HOST;
  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--port must be an integer between 0 and 65535, got "${portArg}"\n`);
    return 1;
  }

  // Authentication: OIDC/JWT (multi-tenant, per-user identity + scopes) when an
  // issuer + audience are configured, else the static single-operator token,
  // else open (loopback only). OIDC wins when both are present.
  const token = process.env.JAIPH_SERVE_TOKEN;
  const oidcIssuer = process.env.JAIPH_SERVE_OIDC_ISSUER?.trim();
  const oidcAudience = process.env.JAIPH_SERVE_OIDC_AUDIENCE?.trim();
  const oidcJwksUri = process.env.JAIPH_SERVE_OIDC_JWKS_URI?.trim();
  if ((oidcIssuer && !oidcAudience) || (!oidcIssuer && oidcAudience)) {
    process.stderr.write(
      "jaiph serve: OIDC mode requires both JAIPH_SERVE_OIDC_ISSUER and JAIPH_SERVE_OIDC_AUDIENCE\n",
    );
    return 1;
  }
  const authConfig: AuthConfig =
    oidcIssuer && oidcAudience
      ? { oidc: { issuer: oidcIssuer, audience: oidcAudience, jwksUri: oidcJwksUri || undefined } }
      : { token };
  const authenticator = createAuthenticator(authConfig);

  // No token and no OIDC is the default: every REST and /mcp request is the
  // anonymous principal with all capabilities. Loopback binds in that mode
  // without a flag. A non-loopback bind still needs --allow-anonymous (Docker
  // must listen on 0.0.0.0). Decided before any socket is opened.
  if (!authenticator.enabled && !isLoopbackHost(host)) {
    if (!allowAnonymous) {
      process.stderr.write(
        `jaiph serve: refusing to bind non-loopback host "${host}" without authentication ` +
          "(every REST and /mcp endpoint would be unauthenticated arbitrary shell). Set JAIPH_SERVE_TOKEN or configure " +
          "OIDC (JAIPH_SERVE_OIDC_ISSUER + JAIPH_SERVE_OIDC_AUDIENCE), or pass --allow-anonymous to run open.\n",
      );
      return 1;
    }
    process.stderr.write(
      "jaiph serve: WARNING --allow-anonymous — no authentication configured. The server is bound on a " +
        "non-loopback address and is open to anyone who can reach the port: every REST and /mcp request " +
        "is authorized as an anonymous principal with all capabilities over all runs. Set JAIPH_SERVE_TOKEN " +
        "or configure OIDC unless you intend this.\n",
    );
  }

  // Hide the API surface (/docs + /openapi.json) with JAIPH_SERVE_EXPOSE_DOCS=false.
  const exposeDocs = !/^(false|0)$/i.test((process.env.JAIPH_SERVE_EXPOSE_DOCS ?? "").trim());

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
    process.stderr.write(`${errText(err)}\n`);
    return 1;
  }
  const outputCaps: OutputCaps = {
    stdout: maxOutputBytes,
    stderr: maxOutputBytes,
    logs: maxOutputBytes,
    resultText: maxOutputBytes,
  };

  // Load generation 0 into a temp root and resolve the startup posture
  // (the shared server prefix; auth/host/port/bounds above run first so an
  // invalid config fails before credential pre-flight).
  const started = startGeneration(pre.args, "runs");
  if ("code" in started) return started.code;
  const ctx = started.ctx;
  const { generations, posture, inputAbs, cleanup } = ctx;
  const hostRunsRoot = posture.hostRunsRoot;

  // Operator log (stderr only, never an HTTP response body): per-call banners +
  // optional workflow-log mirror, over the same injectable `log` sink used for
  // lifecycle lines. Host execution is announced once at startup.
  const operator = createOperatorLog({
    label: "jaiph serve",
    write: log,
  });

  // Track in-flight run promises so shutdown can drain them.
  const inFlightRuns = new Set<Promise<unknown>>();

  // Reconstruct durable run state from the runs tree: reload terminal runs from
  // their persisted run.json and reconcile any run left `running` by a previous
  // process death into the terminal `interrupted` state. A restart therefore
  // keeps list/get/events/artifacts and idempotency working for prior runs.
  let initialRuns: ReturnType<typeof loadPersistedRuns> = [];
  try {
    log(`jaiph serve: reconstructing runs from ${hostRunsRoot}...`);
    const reconstructStarted = Date.now();
    initialRuns = loadPersistedRuns(hostRunsRoot, new Date().toISOString());
    log(
      `jaiph serve: reconstructed ${initialRuns.length} run(s) from ${hostRunsRoot} in ${Date.now() - reconstructStarted}ms`,
    );
  } catch (err) {
    log(`jaiph serve: could not reconstruct prior runs: ${errText(err)}`);
  }

  const handler = new ServeHandler({
    version: VERSION,
    serverTitle: `jaiph — ${basename(inputAbs)}`,
    authenticator,
    exposeDocs,
    maxConcurrent,
    retainRuns,
    retainAgeSec,
    maxArtifactBytes,
    log,
    now: () => new Date().toISOString(),
    initialRuns,
    // Persist each run's public record beside its journal at finalize so a
    // restart can reload it (and its idempotency key) from disk.
    persistRun: persistRunRecord,
    // A run's dir is only recorded on its object at finalize; while it runs the
    // events/artifacts endpoints locate it by scanning the host runs root for
    // the run id.
    // The handler caches the first hit per record, so a live SSE poll loop
    // scans at most once.
    resolveRunDir: (record) => findRunDir(hostRunsRoot, record.run_id),
    getTools: () => generations.current().tools,
    callTool: (spec, args, runId, ctx) => {
      // Bind the run to the generation live at start; the lease keeps its
      // scripts dir alive until the run finishes (deleted then if superseded).
      const lease = generations.acquire();
      const p = callDef(
        lease.state.callEnv,
        spec.def,
        spec.params.map((pp) => args[pp] ?? ""),
        runId,
        { ...ctx, operator },
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
  const watcher = startReloadWatcher(ctx, { reloaded: "def(s)", keepPrevious: "defs" });

  const httpServer = createHttpServer(handler, log);
  let boundPort: number;
  try {
    boundPort = await listen(httpServer, host, port);
  } catch (err) {
    log(`jaiph serve: failed to listen on ${host}:${port}: ${errText(err)}`);
    watcher.stop();
    cleanup();
    return 1;
  }

  const base = `http://${host}:${boundPort}`;
  log(
    `jaiph serve: listening on ${base} — API docs at ${base}/docs, MCP at ${base}/mcp ` +
      `(${generations.current().tools.length} def(s))`,
  );
  log(
    `jaiph serve: auth mode ${authenticator.mode}` +
      (authenticator.mode === "oidc" ? ` (issuer ${oidcIssuer}, audience ${oidcAudience})` : "") +
      `; docs ${exposeDocs ? "exposed at /docs + /openapi.json" : "hidden (JAIPH_SERVE_EXPOSE_DOCS=false)"}.`,
  );
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
      cleanup();
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
