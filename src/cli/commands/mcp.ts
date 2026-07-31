import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { errText } from "../../errors";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs } from "../shared/usage";
import { resolveEnvPairs } from "../run/env";
import { McpServer } from "../mcp/server";
import { callWorkflow } from "../exec/call";
import {
  loadGeneration,
  createGenerationTracker,
  createSourceWatcher,
  resolveStartupPosture,
  logStartupPosture,
  WATCH_INTERVAL_MS,
  type GenerationTracker,
  type StartupPosture,
} from "../shared/generation";
import { VERSION } from "../../version";

const MCP_USAGE =
  "Usage: jaiph mcp [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh>\n\n" +
  "Serve the file's workflows as MCP tools over stdio (newline-delimited JSON-RPC).\n" +
  "Exposure: `export workflow` declarations if any exist, otherwise every top-level\n" +
  "workflow except channel route targets. `default` is exposed only when it is the\n" +
  "only workflow, under a tool name derived from the file's basename.\n" +
  "Tool descriptions come from the `#` comment lines directly above each workflow.\n" +
  "Sources are re-validated on change and clients get notifications/tools/list_changed.\n\n" +
  "Tool calls honor the same env-driven Docker sandbox as `jaiph run`: the workspace\n" +
  "is isolated by default via a writable point-in-time snapshot taken at call start.\n" +
  "Use --inplace (JAIPH_INPLACE=1) to bind the live workspace read-write (effects land\n" +
  "on the host), or --unsafe (JAIPH_UNSAFE=true) to run on the host with no sandbox.\n\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  --env KEY=VALUE    define KEY in every tool call's env (repeatable); --env KEY forwards the host value\n" +
  "  --inplace          Docker sandbox with the host workspace bind-mounted rw for every call (JAIPH_INPLACE=1)\n" +
  "  --unsafe           every call runs on the host with no sandbox (JAIPH_UNSAFE=true)\n" +
  "  -y, --yes          record auto-consent for the posture (JAIPH_INPLACE_YES=1)\n" +
  "  -h, --help         show this help\n\n" +
  "Execution policy: --workspace/--env/--inplace/--unsafe/--yes are shared with jaiph run and\n" +
  "jaiph serve. Precedence: CLI flags > JAIPH_* env vars > workflow config metadata > defaults.\n" +
  "--inplace and --unsafe conflict (E_FLAG_CONFLICT, at startup before anything is spawned).\n" +
  "The effective sandbox posture is resolved and printed once at startup and applied to every\n" +
  "tool call (no interactive prompt). Host-only (unsafe) mode requires explicit consent on the\n" +
  "command line: pass --unsafe (or --yes). An inherited JAIPH_UNSAFE=true with no such flag is\n" +
  "refused at startup (E_UNSAFE_NO_CONSENT). Inside a container the container itself is the\n" +
  "sandbox (the runtime image bakes JAIPH_UNSAFE=true), so host-only execution there is the\n" +
  "documented standalone posture and needs no flag.\n\n" +
  "Example:\n" +
  "  claude mcp add mytools -- jaiph mcp ./tools.jh\n";

export async function runMcp(rest: string[]): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(MCP_USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest, "mcp");
  } catch (err) {
    process.stderr.write(`${errText(err)}\n`);
    return 1;
  }
  const { workspace, env, positional, inplace, unsafe, yes } = parsed;
  const sandboxFlags = { inplace, unsafe, yes };
  const input = positional[0];
  if (!input) {
    process.stderr.write("jaiph mcp requires a .jh file path\n");
    return 1;
  }
  // `--env` pairs apply to every tool call for the server's lifetime; resolve
  // (and bare-form host lookup / E_ENV_MISSING) once before the server starts.
  let extraEnv: Record<string, string>;
  try {
    extraEnv = resolveEnvPairs(env, process.env);
  } catch (err) {
    process.stderr.write(`${errText(err)}\n`);
    return 1;
  }
  const inputAbs = resolve(input);
  if (!existsSync(inputAbs) || !statSync(inputAbs).isFile() || extname(inputAbs) !== ".jh") {
    process.stderr.write("jaiph mcp expects a single .jh file\n");
    return 1;
  }
  const workspaceRoot = workspace ? resolve(workspace) : detectWorkspaceRoot(dirname(inputAbs));
  if (workspace && (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory())) {
    process.stderr.write(`--workspace path is not a directory: ${workspaceRoot}\n`);
    return 1;
  }

  // stdout is the protocol channel from here on; every diagnostic goes to stderr.
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-mcp-"));
  let generation = 0;
  let generations: GenerationTracker;
  try {
    const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph mcp", sandboxFlags);
    if (!loaded.state) {
      for (const f of loaded.failures) log(f);
      rmSync(tempRoot, { recursive: true, force: true });
      return 1;
    }
    generations = createGenerationTracker(loaded.state);
  } catch (err) {
    log(errText(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  // Resolve the sandbox posture once at startup (flags + env, `jaiph run`
  // semantics: isolated snapshot by default, inplace/unsafe as explicit
  // opt-ins). Every tool call applies this posture verbatim.
  let posture: StartupPosture;
  try {
    posture = resolveStartupPosture(generations.current(), inputAbs, workspaceRoot, log);
    logStartupPosture("jaiph mcp", "tool calls", posture, workspaceRoot, log);
  } catch (err) {
    log(errText(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  const server = new McpServer({
    serverVersion: VERSION,
    getTools: () => generations.current().tools,
    callTool: (spec, args, ctx) => {
      // Bind the call to the generation live at start; the lease keeps its
      // scripts dir alive until the call settles (deleted then if superseded).
      const lease = generations.acquire();
      return callWorkflow(
        lease.state.callEnv,
        posture,
        spec.workflow,
        spec.params.map((p) => args[p] ?? ""),
        randomUUID(),
        ctx,
      ).finally(() => lease.release());
    },
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    log,
  });

  // Hot reload: poll every module source; on change re-validate and swap the
  // generation. Validation failures keep the previous generation serving. The
  // tracker deletes the superseded generation's scripts dir only once its last
  // in-flight call settles — a call started just before the reload still runs
  // its remaining script steps from the generation it captured at start.
  let reloading = false;
  const onSourceChange = (): void => {
    if (reloading) return;
    reloading = true;
    try {
      generation += 1;
      const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph mcp", sandboxFlags);
      if (!loaded.state) {
        log("jaiph mcp: reload failed; keeping the previous tool set:");
        for (const f of loaded.failures) log(`  ${f}`);
        return;
      }
      generations.swap(loaded.state);
      watcher.rewatch([...loaded.state.graph.modules.keys()]);
      server.notifyToolsChanged();
      log(`jaiph mcp: sources reloaded (${loaded.state.tools.length} tool(s))`);
    } catch (err) {
      log(`jaiph mcp: reload failed; keeping the previous tool set: ${errText(err)}`);
    } finally {
      reloading = false;
    }
  };
  const watcher = createSourceWatcher(WATCH_INTERVAL_MS, onSourceChange);
  watcher.rewatch([...generations.current().graph.modules.keys()]);

  log(`jaiph mcp: serving ${generations.current().tools.length} tool(s) from ${inputAbs} over stdio`);

  return await new Promise<number>((resolveExit) => {
    let draining = false;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      watcher.stop();
      rmSync(tempRoot, { recursive: true, force: true });
      resolveExit(code);
    };
    // Handle requests concurrently: a long tools/call must not stall pings or
    // further calls. JSON-RPC matches responses by id, so ordering is free to
    // interleave; each outbound message is a single atomic stdout write.
    const inFlight = new Set<Promise<void>>();
    // Drain-then-cancel shutdown: stop accepting input, let in-flight calls
    // settle, then clean up. The temp root (scripts, graph files) must outlive
    // every draining call — a run reads its scripts dir until it exits.
    const drain = (): void => {
      if (draining) return;
      draining = true;
      watcher.stop();
      void Promise.allSettled([...inFlight]).then(() => finish(0));
    };

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const p = server.handleLine(line).catch((err) => {
        log(`jaiph mcp: ${errText(err)}`);
      });
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    });
    rl.on("close", drain);
    const onSignal = (): void => {
      if (!draining) {
        log("jaiph mcp: shutting down; draining in-flight calls (signal again to cancel them)...");
        rl.close();
        drain();
      } else {
        // Second signal: kill every in-flight run's child process tree and, in
        // Docker mode, force-remove its container; the calls then settle and
        // the drain above finishes cleanup.
        log("jaiph mcp: cancelling in-flight calls...");
        server.cancelAll();
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
