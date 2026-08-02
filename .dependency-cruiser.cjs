// Enforces the agent-analyzability import graph: the layer DAG and no-cycles
// invariant from docs/agent-analyzability.md. `npm run arch:check` runs this.
// Layer paths (downward-only imports):
//   4 CLI       src/cli/**, src/cli.ts
//   3 Runtime   src/runtime/**            (may reuse only the transpile public
//                                          module-graph API)
//   2 Compile   src/transpile/**, src/transpiler.ts
//   1 Parse/fmt src/parse/**, src/parser.ts, src/format/**
//   0 Shared    src/types.ts, src/errors.ts, src/diagnostics.ts, src/version.ts,
//               src/env-reserved.ts, src/inline-script-name.ts
// The table in docs/agent-analyzability.md is authoritative; keep these in sync.

const LAYER0 =
  "^src/(types|errors|diagnostics|version|env-reserved|inline-script-name)\\.ts$";
const LAYER1 = "^src/(parse/|parser\\.ts$|format/)";
const LAYER2 = "^src/(transpile/|transpiler\\.ts$)";
const LAYER3 = "^src/runtime/";
const LAYER4 = "^src/(cli/|cli\\.ts$)";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "Cycles break the 'direct deps' interfaces suffice' analyzability story: each side needs the other's body.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "layer0-shared-leaf-no-upward",
      comment:
        "Shared leaf (layer 0) may import only other layer-0 files, never parse/format/transpile/runtime/cli.",
      severity: "error",
      from: { path: LAYER0 },
      to: { path: `${LAYER1}|${LAYER2}|${LAYER3}|${LAYER4}` },
    },
    {
      name: "layer1-parse-format-no-upward",
      comment:
        "Parse/format (layer 1) may import only layer 0, never transpile/runtime/cli.",
      severity: "error",
      from: { path: LAYER1 },
      to: { path: `${LAYER2}|${LAYER3}|${LAYER4}` },
    },
    {
      name: "layer2-transpile-no-upward",
      comment:
        "Compile (layer 2) must not import runtime or cli (generalizes no-runtime-imports.test.ts).",
      severity: "error",
      from: { path: LAYER2 },
      to: { path: `${LAYER3}|${LAYER4}` },
    },
    {
      name: "layer3-runtime-no-cli",
      comment: "Runtime (layer 3) must not import cli (layer 4).",
      severity: "error",
      from: { path: LAYER3 },
      to: { path: LAYER4 },
    },
    {
      name: "layer3-runtime-only-transpile-public-graph",
      comment:
        "Runtime may reuse only the transpile public module-graph API (src/transpile/module-graph.ts, src/transpiler.ts), never transpile internals (validators, emit, etc.).",
      severity: "error",
      from: { path: LAYER3 },
      to: { path: "^src/transpile/", pathNot: "^src/transpile/module-graph\\.ts$" },
    },
    {
      name: "no-deep-imports-into-parse",
      comment:
        "Parse is a deep module: code OUTSIDE the parse package imports only its public entry (src/parser.ts), never src/parse/** internals. Add a named re-export to src/parser.ts instead of reaching in.",
      severity: "error",
      from: { pathNot: "^src/(parse/|parser\\.ts$)" },
      to: { path: "^src/parse/" },
    },
    {
      name: "no-orphans",
      comment:
        "Orphan modules (no incoming or outgoing deps) are usually dead code or a missing wiring.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "\\.test\\.ts$",
          "\\.acceptance\\.test\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
