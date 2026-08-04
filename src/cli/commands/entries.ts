// Grouped command entry points for the CLI dispatch table (src/cli/index.ts).
// The dispatcher references one function per subcommand; importing each command
// module directly there pushes its fan-out past the analyzability cap, so the
// eager commands are re-exported here through one module. Explicit named
// re-exports only — no `export *` (docs/agent-analyzability.md). `serve` is not
// listed: index.ts loads it lazily (it pulls in the OIDC/JWT + HTTP stack).
export { runWorkflow } from "./run";
export { runTest } from "./test";
export { runInit } from "./init";
export { runUse } from "./use";
export { runFormat } from "./format";
export { runInstall } from "./install";
export { runCompile } from "./compile";
export { runMcp } from "./mcp";
