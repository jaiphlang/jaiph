import { errText } from "../../errors";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { McpServer } from "../shared/mcp-server";
import { callDef } from "../shared/workflow-call";
import { parseServerArgs, startGeneration, startReloadWatcher } from "../shared/serve-bootstrap";
import { createOperatorLog } from "../shared/server-log";
import { VERSION } from "../../version";

const MCP_USAGE =
  "Usage: jaiph mcp [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>\n\n" +
  "Serve the file's exported defs as MCP tools over stdio (newline-delimited JSON-RPC).\n" +
  "Exposure: exported defs only. `main` is exposed only when it is the only export,\n" +
  "under a tool name derived from the file's basename.\n" +
  "Tool descriptions come from the `#` comment lines directly above each def.\n" +
  "Sources are re-validated on change and clients get notifications/tools/list_changed.\n\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  --env KEY=VALUE    define KEY in every tool call's env (repeatable); --env KEY forwards the host value\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  claude mcp add mytools -- jaiph mcp ./tools.jh\n";

export async function runMcp(rest: string[]): Promise<number> {
  const parsed = parseServerArgs("mcp", rest, MCP_USAGE);
  if ("code" in parsed) return parsed.code;
  const started = startGeneration(parsed.args, "tool calls");
  if ("code" in started) return started.code;
  const ctx = started.ctx;
  const { generations, inputAbs, log } = ctx;

  // Operator log (stderr only, never MCP stdout): per-call banners + optional
  // workflow-log mirror, over the same injectable `log` sink used for lifecycle
  // lines. Host execution is announced once at startup.
  const operator = createOperatorLog({
    label: "jaiph mcp",
    write: log,
  });

  const server = new McpServer({
    serverVersion: VERSION,
    getTools: () => generations.current().tools,
    callTool: (spec, args, callCtx) => {
      // Bind the call to the generation live at start; the lease keeps its
      // scripts dir alive until the call settles (deleted then if superseded).
      const lease = generations.acquire();
      return callDef(
        lease.state.callEnv,
        spec.def,
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
        // Second signal: kill every in-flight run's child process tree; the
        // calls then settle and the drain above finishes cleanup.
        log("jaiph mcp: cancelling in-flight calls...");
        server.cancelAll();
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
