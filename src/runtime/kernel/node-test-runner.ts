import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRuntimeGraph, resolveWorkflowRef, resolveRuleRef, resolveScriptRef, type RuntimeGraph } from "./graph";
import type { ModuleGraph } from "../../transpile/module-graph";
import { NodeWorkflowRuntime, type MockBodyDef } from "./node-workflow-runtime";
import type { MockPromptArm } from "./mock";
import type { TestBlockDef, TestStepDef } from "../../types";

type TestResult = { pass: boolean; error?: string };

type MockRefStep = Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_script" }>;

/**
 * Resolve the second argument of an `expect_*` step. Returns the literal value
 * when the step was authored with a quoted string, or looks up `varName` in
 * `vars` when the step was authored with a bare identifier referring to a
 * `test_const`. Returns an `Error` (not throws) so callers can surface a clear
 * test failure rather than crashing the run.
 */
function resolveExpectArg(
  vars: Map<string, string>,
  literal: string,
  varName: string | undefined,
): string | Error {
  if (varName === undefined) return literal;
  if (!vars.has(varName)) {
    return new Error(`expect: undefined const "${varName}" (declare it earlier in the test block)`);
  }
  return vars.get(varName)!;
}

function resolveMockBodies(
  graph: RuntimeGraph,
  entryFile: string,
  mockSteps: MockRefStep[],
): Map<string, MockBodyDef> {
  const bodies = new Map<string, MockBodyDef>();
  for (const step of mockSteps) {
    const ref = step.ref;
    const loc = { line: 1, col: 1 };
    let key: string | null = null;
    if (step.type === "test_mock_workflow") {
      const resolved = resolveWorkflowRef(graph, entryFile, { value: ref, loc });
      if (resolved) key = `${resolved.filePath}::${resolved.workflow.name}`;
    } else if (step.type === "test_mock_rule") {
      const resolved = resolveRuleRef(graph, entryFile, { value: ref, loc });
      if (resolved) key = `${resolved.filePath}::${resolved.rule.name}`;
    } else if (step.type === "test_mock_script") {
      const resolved = resolveScriptRef(graph, entryFile, ref);
      if (resolved) key = `${resolved.filePath}::${resolved.script.name}`;
    }
    let mockDef: MockBodyDef;
    if (step.type === "test_mock_script") {
      mockDef = { kind: "shell", body: step.body, params: step.params };
    } else {
      mockDef = { kind: "steps", steps: step.steps, params: step.params };
    }
    if (key) {
      bodies.set(key, mockDef);
    } else {
      // Fallback: use raw ref (for local refs within the same file)
      bodies.set(ref, mockDef);
    }
  }
  return bodies;
}

function buildMockArms(
  step: Extract<TestStepDef, { type: "test_mock_prompt_block" }>,
): MockPromptArm[] {
  return step.arms.map((arm): MockPromptArm => {
    const response = arm.body
      .replace(/^["']|["']$/g, "")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
    if (arm.pattern.kind === "string_literal") return { kind: "string", pattern: arm.pattern.value, response };
    if (arm.pattern.kind === "regex") return { kind: "regex", pattern: arm.pattern.source, response };
    return { kind: "wildcard", response };
  });
}

async function runTestBlock(
  block: TestBlockDef,
  testFileAbs: string,
  workspaceRoot: string,
  scriptsDir: string,
  graph: RuntimeGraph,
): Promise<TestResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-test-block-"));
  try {
    const mockResponses: string[] = [];
    let mockArmsJson = "";
    const mockRefs: Array<Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_script" }>> = [];
    const vars = new Map<string, string>();

    // Collect mock setup. Walk in source order so that `const` bindings declared
    // before a `mock prompt <ident>` are available when the response is resolved.
    for (const step of block.steps) {
      if (step.type === "comment" || step.type === "blank_line") {
        continue;
      }
      if (step.type === "test_const") {
        vars.set(step.name, step.value);
        continue;
      }
      if (step.type === "test_mock_prompt") {
        if (step.responseVar !== undefined) {
          if (!vars.has(step.responseVar)) {
            return {
              pass: false,
              error: `mock prompt: undefined const "${step.responseVar}" (declare it earlier in the test block)`,
            };
          }
          mockResponses.push(vars.get(step.responseVar)!);
        } else {
          mockResponses.push(step.response);
        }
      }
      if (step.type === "test_mock_prompt_block") {
        mockArmsJson = JSON.stringify(buildMockArms(step));
      }
      if (step.type === "test_mock_workflow" || step.type === "test_mock_rule" || step.type === "test_mock_script") {
        mockRefs.push(step);
      }
    }

    // Encode sequential mock responses as JSON for the in-process runtime queue.
    const mockResponsesJson = mockResponses.length > 0 && !mockArmsJson
      ? JSON.stringify(mockResponses)
      : "";

    // Execute test steps
    for (const step of block.steps) {
      if (step.type === "comment" || step.type === "blank_line") {
        continue;
      }
      if (step.type === "test_mock_prompt" || step.type === "test_mock_prompt_block" ||
          step.type === "test_mock_workflow" || step.type === "test_mock_rule" ||
          step.type === "test_mock_script" ||
          step.type === "test_const") {
        continue; // Already processed above
      }

      if (step.type === "test_run_workflow") {
        const mockBodies = resolveMockBodies(graph, testFileAbs, mockRefs);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          JAIPH_TEST_MODE: "1",
          JAIPH_WORKSPACE: workspaceRoot,
          JAIPH_RUNS_DIR: join(tmpDir, ".jaiph", "runs"),
          JAIPH_SCRIPTS: scriptsDir,
        };
        if (mockArmsJson) {
          env.JAIPH_MOCK_PROMPT_ARMS_JSON = mockArmsJson;
          delete env.JAIPH_MOCK_RESPONSES_JSON;
        } else if (mockResponsesJson) {
          env.JAIPH_MOCK_RESPONSES_JSON = mockResponsesJson;
          delete env.JAIPH_MOCK_PROMPT_ARMS_JSON;
        }
        const runtime = new NodeWorkflowRuntime(graph, {
          env,
          cwd: workspaceRoot,
          mockBodies,
          suppressLiveEvents: true,
        });
        const result = await runtime.runNamedWorkflow(step.workflowRef, step.args ?? []);
        // Resolve the captured value following production `run_capture` semantics.
        // Only an explicit `const X = run …` binding introduces a variable; there is no
        // implicit alias — `expect_*` must reference an explicitly-captured name.
        if (step.captureName) {
          let runValue: string | undefined;
          if (result.status === 0 && result.returnValue) {
            runValue = result.returnValue;
          } else if (result.status !== 0 && result.error) {
            runValue = result.error.trim();
          } else {
            // No explicit return — read all .out artifact files (matches bash harness semantics).
            const runDir = runtime.getRunDir();
            try {
              const outFiles = readdirSync(runDir)
                .filter((f) => f.endsWith(".out"))
                .sort();
              let captured = "";
              for (const outFile of outFiles) {
                captured += readFileSync(join(runDir, outFile), "utf8");
              }
              runValue = captured;
            } catch {
              runValue = result.output;
            }
          }
          if (runValue !== undefined) {
            vars.set(step.captureName, runValue);
          }
        }
        if (!step.allowFailure && result.status !== 0) {
          return { pass: false, error: `workflow exited with status ${result.status}` };
        }
        continue;
      }

      if (step.type === "test_expect_contain") {
        if (!vars.has(step.variable)) {
          return { pass: false, error: `expect_contain: undefined variable "${step.variable}" (capture it first with: const ${step.variable} = run …)` };
        }
        const value = vars.get(step.variable) ?? "";
        const substring = resolveExpectArg(vars, step.substring, step.substringVar);
        if (substring instanceof Error) return { pass: false, error: substring.message };
        if (!value.includes(substring)) {
          return {
            pass: false,
            error: `expect_contain failed: "${step.variable}" (${value.length} chars) does not contain "${substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_not_contain") {
        if (!vars.has(step.variable)) {
          return { pass: false, error: `expect_not_contain: undefined variable "${step.variable}" (capture it first with: const ${step.variable} = run …)` };
        }
        const value = vars.get(step.variable) ?? "";
        const substring = resolveExpectArg(vars, step.substring, step.substringVar);
        if (substring instanceof Error) return { pass: false, error: substring.message };
        if (value.includes(substring)) {
          return {
            pass: false,
            error: `expect_not_contain failed: "${step.variable}" contains "${substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_equal") {
        if (!vars.has(step.variable)) {
          return { pass: false, error: `expect_equal: undefined variable "${step.variable}" (capture it first with: const ${step.variable} = run …)` };
        }
        const value = vars.get(step.variable) ?? "";
        const expected = resolveExpectArg(vars, step.expected, step.expectedVar);
        if (expected instanceof Error) return { pass: false, error: expected.message };
        if (value !== expected) {
          return {
            pass: false,
            error: `expect_equal failed:\n    - ${expected}\n    + ${value}`,
          };
        }
        continue;
      }
    }

    return { pass: true };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runTestFile(
  moduleGraph: ModuleGraph,
  workspaceRoot: string,
  scriptsDir: string,
  blocks: TestBlockDef[],
): Promise<number> {
  const testFileAbs = moduleGraph.entryFile;
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const dim = "\x1b[2m";
  const colorEnabled = process.env.NO_COLOR === undefined;
  const displayName = basename(testFileAbs);

  const writeExpectEqualDetailLine = (line: string): void => {
    if (!colorEnabled) {
      process.stdout.write(`${line}\n`);
      return;
    }
    const minus = /^(\s*)- (.*)$/;
    const plus = /^(\s*)\+ (.*)$/;
    const m = minus.exec(line);
    if (m) {
      process.stdout.write(`${m[1]}${dim}- ${m[2]}${reset}\n`);
      return;
    }
    const p = plus.exec(line);
    if (p) {
      process.stdout.write(`${p[1]}${red}+ ${p[2]}${reset}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  };

  process.stdout.write(`${bold}testing${reset} ${displayName}\n`);

  // Build the runtime view of the already-loaded module graph once for the
  // entire test file. The graph depends only on testFileAbs and its import
  // closure, which are constant across all blocks and steps within a single
  // runTestFile call. If a future test step mutates imported files on disk
  // mid-run, a manual rebuild would be needed — but that is not a supported
  // pattern today.
  const graph = buildRuntimeGraph(moduleGraph, workspaceRoot);

  let total = 0;
  let failed = 0;
  const failedNames: string[] = [];
  let lastFailureHadDetailLines = false;

  for (const block of blocks) {
    total += 1;
    const start = Date.now();
    const result = await runTestBlock(block, testFileAbs, workspaceRoot, scriptsDir, graph);
    const elapsed = Math.floor((Date.now() - start) / 1000);

    process.stdout.write(`  \u25b8 ${block.description}\n`);
    if (result.pass) {
      lastFailureHadDetailLines = false;
      process.stdout.write(`  ${green}\u2713${reset} ${dim}${elapsed}s${reset}\n`);
    } else {
      failed += 1;
      failedNames.push(block.description);
      const [errorLine, ...detailLines] = (result.error ?? "unknown error").split("\n");
      process.stdout.write(`  ${red}\u2717${reset} ${errorLine} ${dim}${elapsed}s${reset}\n`);
      for (const dl of detailLines) {
        if (dl.length === 0) continue;
        writeExpectEqualDetailLine(dl);
      }
      lastFailureHadDetailLines = detailLines.length > 0;
      if (detailLines.length > 0) {
        process.stdout.write("\n");
      }
    }
  }

  if (failed > 0) {
    if (lastFailureHadDetailLines) {
      process.stdout.write("\n");
    }
    process.stdout.write(`\n${bold}${red}\u2717 ${failed} / ${total} test(s) failed${reset}\n`);
    for (const name of failedNames) {
      process.stdout.write(`  - ${name}\n`);
    }
    return 1;
  }
  process.stdout.write(`${bold}${green}\u2713 ${total} test(s) passed${reset}\n`);
  return 0;
}
