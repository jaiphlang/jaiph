import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unwatchFile, watchFile } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadModuleGraph, writeModuleGraph, type ModuleGraph } from "../../transpile/module-graph";
import { collectDiagnostics } from "../../transpile/validate";
import { buildScriptsFromGraph } from "../../transpiler";
import { resolveModuleMetadata, metadataToConfig } from "../../config";
import {
  resolveDockerConfig,
  checkDockerAvailable,
  prepareImage,
  selectMcpSandboxMode,
} from "../../runtime/docker";
import { detectWorkspaceRoot } from "../shared/paths";
import { hasHelpFlag, parseArgs } from "../shared/usage";
import { resolveRuntimeEnv, resolveEnvPairs } from "../run/env";
import { preflightAgentCredentials } from "../run/preflight-credentials";
import { deriveTools, type McpToolSpec } from "../mcp/tools";
import { McpServer } from "../mcp/server";
import { callWorkflow, type McpCallEnvironment } from "../mcp/call";
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

/** How often watchFile polls module sources for hot reload (ms). */
const WATCH_INTERVAL_MS = 750;

interface McpState {
  graph: ModuleGraph;
  tools: McpToolSpec[];
  callEnv: McpCallEnvironment;
}

/**
 * Load (or reload) everything one generation of the server needs: module
 * graph, compile-time validation, tool derivation, emitted scripts, and the
 * serialized graph the spawned runners consume. Throws on parse errors;
 * returns diagnostics without throwing on validation errors.
 */
function loadState(
  inputAbs: string,
  workspaceRoot: string,
  tempRoot: string,
  generation: number,
  extraEnv: Record<string, string>,
  log: (line: string) => void,
): { state?: McpState; failures: string[] } {
  const graph = loadModuleGraph(inputAbs, workspaceRoot);
  const diag = collectDiagnostics(graph);
  if (diag.errors.length > 0) {
    return {
      failures: diag.sorted().map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`),
    };
  }

  const mod = graph.modules.get(inputAbs)!.ast;
  const { tools, warnings } = deriveTools(mod, inputAbs);
  for (const w of warnings) log(`jaiph mcp: ${w}`);

  const outDir = join(tempRoot, `gen-${generation}`);
  mkdirSync(outDir, { recursive: true });
  const { scriptsDir } = buildScriptsFromGraph(graph, outDir);
  const graphFile = join(outDir, ".jaiph-module-graph.json");
  writeModuleGraph(graphFile, graph);

  const resolvedModuleMetadata = resolveModuleMetadata(mod, process.env);
  const effectiveConfig = metadataToConfig(resolvedModuleMetadata);

  return {
    state: {
      graph,
      tools,
      callEnv: { inputAbs, workspaceRoot, mod, effectiveConfig, scriptsDir, graphFile, outDir, extraEnv },
    },
    failures: [],
  };
}

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
  let state: McpState;
  try {
    const loaded = loadState(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log);
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
  const mod = state.graph.modules.get(inputAbs)!.ast;
  const startupEnv = resolveRuntimeEnv(state.callEnv.effectiveConfig, workspaceRoot, inputAbs);
  const dockerConfig = resolveDockerConfig(resolveModuleMetadata(mod, process.env)?.runtime, startupEnv);
  if (dockerConfig.enabled) {
    // Prepare the image once here rather than per call (a cold pull is slow).
    try {
      checkDockerAvailable();
      prepareImage(dockerConfig);
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      rmSync(tempRoot, { recursive: true, force: true });
      return 1;
    }
    const mode = selectMcpSandboxMode(startupEnv);
    if (mode === "inplace") {
      log(
        `jaiph mcp: tool calls run in a Docker sandbox in-place on ${workspaceRoot} ` +
          "(JAIPH_INPLACE=1 opt-in: effects land live on the workspace).",
      );
    } else {
      log(`jaiph mcp: tool calls run in a Docker sandbox (${mode} mode; workspace isolated).`);
    }
  }
  // Credential pre-flight once at startup (warnings only in MCP mode: the
  // server may outlive a credential fix, and per-call failures still surface).
  const credPreflight = preflightAgentCredentials({
    mod,
    inputAbs,
    runtimeEnv: startupEnv,
    dockerEnabled: dockerConfig.enabled,
  });
  for (const w of [...credPreflight.warnings, ...credPreflight.errors]) log(w);

  const server = new McpServer({
    serverVersion: VERSION,
    getTools: () => state.tools,
    callTool: (spec, args, ctx) =>
      callWorkflow(
        state.callEnv,
        dockerConfig,
        spec.workflow,
        spec.params.map((p) => args[p] ?? ""),
        ctx,
      ),
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    log,
  });

  // Hot reload: poll every module source; on change re-validate and swap the
  // generation. Validation failures keep the previous generation serving.
  let watched: string[] = [];
  const rewatch = (): void => {
    for (const f of watched) unwatchFile(f, onSourceChange);
    watched = [...state.graph.modules.keys()];
    for (const f of watched) watchFile(f, { interval: WATCH_INTERVAL_MS }, onSourceChange);
  };
  let reloading = false;
  const onSourceChange = (): void => {
    if (reloading) return;
    reloading = true;
    try {
      generation += 1;
      const loaded = loadState(inputAbs, workspaceRoot, tempRoot, generation, extraEnv, log);
      if (!loaded.state) {
        log("jaiph mcp: reload failed; keeping the previous tool set:");
        for (const f of loaded.failures) log(`  ${f}`);
        return;
      }
      const previousOutDir = state.callEnv.outDir;
      state = loaded.state;
      rewatch();
      server.notifyToolsChanged();
      log(`jaiph mcp: sources reloaded (${state.tools.length} tool(s))`);
      rmSync(previousOutDir, { recursive: true, force: true });
    } catch (err) {
      log(`jaiph mcp: reload failed; keeping the previous tool set: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reloading = false;
    }
  };
  rewatch();

  log(`jaiph mcp: serving ${state.tools.length} tool(s) from ${inputAbs} over stdio`);

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      for (const f of watched) unwatchFile(f, onSourceChange);
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
