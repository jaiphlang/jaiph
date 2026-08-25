import importPlugin from "eslint-plugin-import";
import tsParser from "@typescript-eslint/parser";

// Enforces the agent-analyzability fan-out and file-size caps from
// docs/agent-analyzability.md: production units under src/ stay at
// <= 8 runtime imports (import/max-dependencies, type imports ignored) and
// <= 400 non-blank, non-comment lines (max-lines). `npm run lint` runs this
// with --max-warnings 0, and CI's unit-test job gates on it.
//
// Grandfathering (baseline policy in the ADR): files that already exceed a cap
// get a minimal per-file override that turns off ONLY the rule they violate,
// each with a one-line justification. The global max is never raised, so any
// NEW violation (or a new import/line pushing another file over) still fails.
// Splitting these files to remove the overrides is queued follow-up work.
export default [
  // Caps target production units an agent must load to reason about behavior.
  // Test files legitimately import many modules and run long (full-output
  // assertions), so they are out of scope for these two rules.
  {
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.acceptance.test.ts",
      "dist/**",
    ],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: { import: importPlugin },
    rules: {
      "import/max-dependencies": ["error", { max: 8, ignoreTypeImports: true }],
      "max-lines": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
    },
  },

  // --- Grandfathered violators (pre-existing; split is queued, do not extend) ---
  // Each override below turns off ONLY the cap the file breaks today, with a
  // one-line reason. Twelve of the original sixteen grandfathered files were
  // split into sibling modules and de-grandfathered in this task (mcp, serve,
  // generation, cli/index, workflow-call, parser, runtime/index, validate,
  // validate-step, format/emit, kernel/prompt). The four below
  // remain: each is an exceptionally large / tightly-coupled unit whose split
  // needs a multi-file decomposition of its own, and is explicit follow-up work
  // out of scope for this change (see fresh per-file reasons below).
  {
    // 608 lines + 24 distinct runtime imports: the `jaiph run` orchestrator
    // wires parse/transpile/runtime + ~9 run-slice helpers. Reaching <= 8 needs
    // the run command decomposed into per-phase modules (a change of its own),
    // beyond grouping — deferred as explicit follow-up.
    files: ["src/cli/commands/run.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // 586 lines + high fan-out: the HTTP handler dispatches every /v1 + /mcp
    // route inline; a clean split is per-route handler modules behind a small
    // router — deferred as explicit follow-up.
    files: ["src/cli/serve/handler.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // 812 lines + 12 imports: the statement parser is a dispatch table whose
    // handlers are mutually recursive with the block-body / attached-block
    // structural parsers, so a file split needs care to avoid an import cycle
    // (dependency-cruiser `no-circular`) — deferred as explicit follow-up.
    files: ["src/parse/workflow-brace.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // 1698 lines + high fan-out: the workflow kernel interpreter, the single
    // largest unit in the tree. Splitting it into cohesive step-executor
    // siblings is the biggest queued decomposition — deferred as explicit
    // follow-up.
    files: ["src/runtime/kernel/node-workflow-runtime.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
];
