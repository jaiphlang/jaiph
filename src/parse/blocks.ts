// Top-level block parsers, grouped so the module dispatcher (`parse-module.ts`)
// reaches them through one import instead of six — keeping its fan-out under the
// analyzability cap. Each is a multi-line construct the dispatcher hands the raw
// line window to. Explicit named re-exports only (docs/agent-analyzability.md).
export { parseConfigBlock } from "./metadata";
export { parseRuleBlock } from "./rules";
export { parseScriptBlock } from "./scripts";
export { parseWorkflowBlock } from "./workflows";
export { parseTestBlock } from "./tests";
export { parseEnvDecl } from "./env";
