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
  // one-line reason. Fixing (splitting) these files is queued follow-up work.
  {
    // High fan-out: mcp command wires transport, runtime, and serve slices.
    files: ["src/cli/commands/mcp.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // 602 lines + high fan-out: run orchestration (launch/progress/hooks).
    files: ["src/cli/commands/run.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // High fan-out: serve command wires server, telemetry, and runtime slices.
    files: ["src/cli/commands/serve.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // High fan-out: the workflow-call executor spans transpile + runtime graph APIs.
    files: ["src/cli/shared/workflow-call.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // High fan-out: cli/index is the command dispatch table (imports each command).
    files: ["src/cli/index.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // 586 lines + high fan-out: HTTP handler, routes not yet split per-route.
    files: ["src/cli/serve/handler.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // High fan-out: shared generation helper spans parse/transpile/runtime.
    files: ["src/cli/shared/generation.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // 721 lines: bash emitter, emit passes not yet split into sibling files.
    files: ["src/format/emit.ts"],
    rules: { "max-lines": "off" },
  },
  {
    // 701 lines + high fan-out: brace/parse concerns not yet separated.
    files: ["src/parse/workflow-brace.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // High fan-out: parser.ts is the parse slice public entry (many sub-parsers).
    files: ["src/parser.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // High fan-out: index.ts is the runtime slice public entry (re-exports the
    // curated CLI-facing surface: graph, launch/runner, docker, emit, ...).
    files: ["src/runtime/index.ts"],
    rules: { "import/max-dependencies": "off" },
  },
  {
    // 717 lines: docker driver (build/run/sandbox config) not yet split.
    files: ["src/runtime/docker.ts"],
    rules: { "max-lines": "off" },
  },
  {
    // 1696 lines + high fan-out: the workflow kernel, largest queued split.
    files: ["src/runtime/kernel/node-workflow-runtime.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // 648 lines + high fan-out: prompt backend dispatch not yet split.
    files: ["src/runtime/kernel/prompt.ts"],
    rules: { "import/max-dependencies": "off", "max-lines": "off" },
  },
  {
    // 1015 lines: step validator, per-step-kind checks not yet split.
    files: ["src/transpile/validate-step.ts"],
    rules: { "max-lines": "off" },
  },
  {
    // 405 lines, just over the cap; trim or split is queued.
    files: ["src/transpile/validate.ts"],
    rules: { "max-lines": "off" },
  },
];
