import { errText } from "../../errors";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { McpServer } from "../shared/mcp-server";
import { callWorkflow } from "../shared/workflow-call";
import { parseServerArgs, startGeneration, startReloadWatcher } from "../shared/serve-bootstrap";
import { createOperatorLog } from "../shared/server-log";
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
  const parsed = parseServerArgs("mcp", rest, MCP_USAGE);
  if ("code" in parsed) return parsed.code;
  const started = startGeneration(parsed.args, "tool calls");
  if ("code" in started) return started.code;
  const ctx = started.ctx;
  const { generations, posture, inputAbs, log } = ctx;

  // Operator log (stderr only, never MCP stdout): per-call banners + optional
  // workflow-log mirror, over the same injectable `log` sink used for lifecycle
  // lines. The sandbox label is resolved once from the startup posture.
  const operator = createOperatorLog({
    label: "jaiph mcp",
    write: log,
    dockerEnabled: posture.dockerConfig.enabled,
    sandboxMode: posture.sandboxMode,
    unsafeHostOnly: posture.unsafeHostOnly,
  });

  const server = new McpServer({
    serverVersion: VERSION,
    getTools: () => generations.current().tools,
    callTool: (spec, args, callCtx) => {
      // Bind the call to the generation live at start; the lease keeps its
      // scripts dir alive until the call settles (deleted then if superseded).
      const lease = generations.acquire();
      return callWorkflow(
        lease.state.callEnv,
        posture,
        spec.workflow,
        spec.params.map((p) => args[p] ?? ""),
        randomUUID(),
        { ...callCtx, operator },
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
  const watcher = startReloadWatcher(
    ctx,
    { reloaded: "tool(s)", keepPrevious: "tool set" },
    () => server.notifyToolsChanged(),
  );

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
      ctx.cleanup();
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
