import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  createSourceWatcher,
  resolveStartupPosture,
  WATCH_INTERVAL_MS,
  type GenerationState,
} from "../shared/generation";
import { VERSION } from "../../version";

const MCP_USAGE =
  "Usage: jaiph mcp [--workspace <dir>] <file.jh>\n\n" +
  "Serve the file's workflows as MCP tools over stdio (newline-delimited JSON-RPC).\n" +
  "Exposure: `export workflow` declarations if any exist, otherwise every top-level\n" +
  "workflow except channel route targets. `default` is exposed only when it is the\n" +
  "only workflow, under a tool name derived from the file's basename.\n" +
  "Tool descriptions come from the `#` comment lines directly above each workflow.\n" +
  "Sources are re-validated on change and clients get notifications/tools/list_changed.\n\n" +
  "Tool calls honor the same env-driven Docker sandbox as `jaiph run`: the workspace\n" +
  "is isolated by default via a writable point-in-time snapshot taken at call start.\n" +
  "Set JAIPH_INPLACE=1 to bind the live workspace read-write (effects land on the\n" +
  "host), or JAIPH_UNSAFE=true to run on the host with no sandbox.\n\n" +
  "  --workspace <dir>  workspace root for import resolution (default: auto-detect)\n" +
  "  -h, --help         show this help\n\n" +
  "Example:\n" +
  "  claude mcp add mytools -- jaiph mcp ./tools.jh\n";

export async function runMcp(rest: string[]): Promise<number> {
  if (hasHelpFlag(rest)) {
    process.stdout.write(MCP_USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { workspace, env, positional } = parsed;
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
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
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
  let state: GenerationState;
  try {
    const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph mcp");
    if (!loaded.state) {
      for (const f of loaded.failures) log(f);
      rmSync(tempRoot, { recursive: true, force: true });
      return 1;
    }
    state = loaded.state;
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  // Resolve the sandbox posture once at startup. Tool calls honor the same
  // env-driven Docker selection as `jaiph run`: the workspace is isolated by
  // default via a point-in-time snapshot. Inplace is an explicit opt-in via
  // JAIPH_INPLACE=1.
  let dockerConfig: ReturnType<typeof resolveStartupPosture>["dockerConfig"];
  try {
    const posture = resolveStartupPosture(state, inputAbs, workspaceRoot, log);
    dockerConfig = posture.dockerConfig;
    if (dockerConfig.enabled) {
      if (posture.sandboxMode === "inplace") {
        log(
          `jaiph mcp: tool calls run in a Docker sandbox in-place on ${workspaceRoot} ` +
            "(JAIPH_INPLACE=1 opt-in: effects land live on the workspace).",
        );
      } else {
        log(`jaiph mcp: tool calls run in a Docker sandbox (${posture.sandboxMode} mode; workspace isolated).`);
      }
    }
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    rmSync(tempRoot, { recursive: true, force: true });
    return 1;
  }

  const server = new McpServer({
    serverVersion: VERSION,
    getTools: () => state.tools,
    callTool: (spec, args, ctx) =>
      callWorkflow(
        state.callEnv,
        dockerConfig,
        spec.workflow,
        spec.params.map((p) => args[p] ?? ""),
        randomUUID(),
        ctx,
      ),
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    log,
  });

  // Hot reload: poll every module source; on change re-validate and swap the
  // generation. Validation failures keep the previous generation serving.
  let reloading = false;
  const onSourceChange = (): void => {
    if (reloading) return;
    reloading = true;
    try {
      generation += 1;
      const loaded = loadGeneration(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log, "jaiph mcp");
      if (!loaded.state) {
        log("jaiph mcp: reload failed; keeping the previous tool set:");
        for (const f of loaded.failures) log(`  ${f}`);
        return;
      }
      const previousOutDir = state.callEnv.outDir;
      state = loaded.state;
      watcher.rewatch([...state.graph.modules.keys()]);
      server.notifyToolsChanged();
      log(`jaiph mcp: sources reloaded (${state.tools.length} tool(s))`);
      rmSync(previousOutDir, { recursive: true, force: true });
    } catch (err) {
      log(`jaiph mcp: reload failed; keeping the previous tool set: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reloading = false;
    }
  };
  const watcher = createSourceWatcher(WATCH_INTERVAL_MS, onSourceChange);
  watcher.rewatch([...state.graph.modules.keys()]);

  log(`jaiph mcp: serving ${state.tools.length} tool(s) from ${inputAbs} over stdio`);

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      watcher.stop();
      rmSync(tempRoot, { recursive: true, force: true });
      resolveExit(code);
    };

    const rl = createInterface({ input: process.stdin, terminal: false });
    // Handle requests concurrently: a long tools/call must not stall pings or
    // further calls. JSON-RPC matches responses by id, so ordering is free to
    // interleave; each outbound message is a single atomic stdout write.
    const inFlight = new Set<Promise<void>>();
    rl.on("line", (line) => {
      const p = server.handleLine(line).catch((err) => {
        log(`jaiph mcp: ${err instanceof Error ? err.message : String(err)}`);
      });
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    });
    rl.on("close", () => {
      void Promise.allSettled([...inFlight]).then(() => shutdown(0));
    });
    process.once("SIGINT", () => shutdown(0));
    process.once("SIGTERM", () => shutdown(0));
  });
}
