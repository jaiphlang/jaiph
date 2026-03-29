import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRuntimeGraph, resolveWorkflowRef, resolveRuleRef, resolveScriptRef, type RuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import type { TestBlockDef, TestStepDef } from "../../types";

type TestResult = { pass: boolean; error?: string };

type MockRefStep = Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_function" }>;

function resolveMockBodies(
  graph: RuntimeGraph,
  entryFile: string,
  mockSteps: MockRefStep[],
): Map<string, string> {
  const bodies = new Map<string, string>();
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
    } else if (step.type === "test_mock_function") {
      const resolved = resolveScriptRef(graph, entryFile, ref);
      if (resolved) key = `${resolved.filePath}::${resolved.script.name}`;
    }
    if (key) {
      bodies.set(key, step.body);
    } else {
      // Fallback: use raw ref (for local refs within the same file)
      bodies.set(ref, step.body);
    }
  }
  return bodies;
}

function writeMockDispatchScript(
  step: Extract<TestStepDef, { type: "test_mock_prompt_block" }>,
  dir: string,
): string {
  const lines: string[] = ["#!/usr/bin/env bash", "set -euo pipefail", 'prompt="${1:-}"'];
  for (let i = 0; i < step.branches.length; i += 1) {
    const { pattern, response } = step.branches[i];
    const cond = i === 0 ? "if" : "elif";
    lines.push(`${cond} [[ "$prompt" == *'${pattern.replace(/'/g, "'\\''")}'* ]]; then`);
    lines.push(`  printf '%s' '${response.replace(/'/g, "'\\''")}'`);
  }
  if (step.elseResponse !== undefined) {
    lines.push("else");
    lines.push(`  printf '%s' '${step.elseResponse.replace(/'/g, "'\\''")}'`);
  } else {
    lines.push("else");
    lines.push('  echo "jaiph: no mock matched prompt (no branch matched). Prompt preview: ${prompt:0:80}..." >&2');
    lines.push("  exit 1");
  }
  lines.push("fi");
  const scriptPath = join(dir, "mock_dispatch.sh");
  writeFileSync(scriptPath, lines.join("\n") + "\n");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function runTestBlock(
  block: TestBlockDef,
  testFileAbs: string,
  workspaceRoot: string,
  scriptsDir: string,
): Promise<TestResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-test-block-"));
  try {
    const mockResponses: string[] = [];
    let mockDispatchPath = "";
    const mockRefs: Array<Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_function" }>> = [];
    const vars = new Map<string, string>();

    // Collect mock setup
    for (const step of block.steps) {
      if (step.type === "test_mock_prompt") {
        mockResponses.push(step.response);
      }
      if (step.type === "test_mock_prompt_block") {
        mockDispatchPath = writeMockDispatchScript(step, tmpDir);
      }
      if (step.type === "test_mock_workflow" || step.type === "test_mock_rule" || step.type === "test_mock_function") {
        mockRefs.push(step);
      }
    }

    // Set up mock responses file
    let mockResponsesFile = "";
    if (mockResponses.length > 0 && !mockDispatchPath) {
      mockResponsesFile = join(tmpDir, "mock_responses.txt");
      writeFileSync(mockResponsesFile, mockResponses.join("\n") + "\n");
    }

    // Execute test steps
    for (const step of block.steps) {
      if (step.type === "test_mock_prompt" || step.type === "test_mock_prompt_block" ||
          step.type === "test_mock_workflow" || step.type === "test_mock_rule" ||
          step.type === "test_mock_function") {
        continue; // Already processed above
      }

      if (step.type === "test_shell") {
        const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
        const r = spawnSync("bash", ["-c", step.command], {
          encoding: "utf8",
          cwd: workspaceRoot,
        });
        if (r.status !== 0) {
          return { pass: false, error: `shell command failed: ${step.command}` };
        }
        continue;
      }

      if (step.type === "test_run_workflow") {
        const graph = buildRuntimeGraph(testFileAbs);
        const mockBodies = resolveMockBodies(graph, testFileAbs, mockRefs);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          JAIPH_TEST_MODE: "1",
          JAIPH_WORKSPACE: workspaceRoot,
          JAIPH_RUNS_DIR: join(tmpDir, ".jaiph", "runs"),
          JAIPH_SCRIPTS: scriptsDir,
        };
        if (mockDispatchPath) {
          env.JAIPH_MOCK_DISPATCH_SCRIPT = mockDispatchPath;
          delete env.JAIPH_MOCK_RESPONSES_FILE;
        } else if (mockResponsesFile) {
          env.JAIPH_MOCK_RESPONSES_FILE = mockResponsesFile;
          delete env.JAIPH_MOCK_DISPATCH_SCRIPT;
        }
        const runtime = new NodeWorkflowRuntime(graph, {
          env,
          cwd: workspaceRoot,
          mockBodies,
        });
        const result = await runtime.runNamedWorkflow(step.workflowRef, step.args ?? []);
        if (step.captureName) {
          // Match production run_capture semantics: prefer returnValue over raw output.
          if (result.status === 0 && result.returnValue) {
            vars.set(step.captureName, result.returnValue);
          } else if (result.status !== 0 && result.error) {
            // Failed workflow: capture error content (matches bash stderr capture)
            vars.set(step.captureName, result.error.trim());
          } else {
            // No explicit return — read all .out artifact files (matches bash harness semantics)
            const runDir = runtime.getRunDir();
            let captured = "";
            try {
              const outFiles = readdirSync(runDir)
                .filter((f) => f.endsWith(".out"))
                .sort();
              for (const outFile of outFiles) {
                captured += readFileSync(join(runDir, outFile), "utf8");
              }
            } catch {
              captured = result.output;
            }
            vars.set(step.captureName, captured);
          }
        }
        if (!step.allowFailure && result.status !== 0) {
          return { pass: false, error: `workflow exited with status ${result.status}` };
        }
        continue;
      }

      if (step.type === "test_expect_contain") {
        const value = vars.get(step.variable) ?? "";
        if (!value.includes(step.substring)) {
          return {
            pass: false,
            error: `expectContain failed: "${step.variable}" (${value.length} chars) does not contain "${step.substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_not_contain") {
        const value = vars.get(step.variable) ?? "";
        if (value.includes(step.substring)) {
          return {
            pass: false,
            error: `expectNotContain failed: "${step.variable}" contains "${step.substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_equal") {
        const value = vars.get(step.variable) ?? "";
        if (value !== step.expected) {
          return {
            pass: false,
            error: `expectEqual failed:\n    - ${step.expected}\n    + ${value}`,
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
  testFileAbs: string,
  workspaceRoot: string,
  scriptsDir: string,
  blocks: TestBlockDef[],
): Promise<number> {
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const dim = "\x1b[2m";
  const displayName = basename(testFileAbs);

  process.stdout.write(`${bold}testing${reset} ${displayName}\n`);

  let total = 0;
  let failed = 0;
  const failedNames: string[] = [];

  for (const block of blocks) {
    total += 1;
    const start = Date.now();
    const result = await runTestBlock(block, testFileAbs, workspaceRoot, scriptsDir);
    const elapsed = Math.floor((Date.now() - start) / 1000);

    process.stdout.write(`  \u25b8 ${block.description}\n`);
    if (result.pass) {
      process.stdout.write(`  ${green}\u2713${reset} ${dim}${elapsed}s${reset}\n`);
    } else {
      failed += 1;
      failedNames.push(block.description);
      const [errorLine, ...detailLines] = (result.error ?? "unknown error").split("\n");
      process.stdout.write(`  ${red}\u2717${reset} ${errorLine} ${dim}${elapsed}s${reset}\n`);
      for (const dl of detailLines) {
        process.stdout.write(`${dl}\n`);
      }
      if (detailLines.length > 0) {
        process.stdout.write("\n");
      }
    }
  }

  if (failed > 0) {
    process.stdout.write(`\n${bold}${red}\u2717 ${failed} / ${total} test(s) failed${reset}\n`);
    for (const name of failedNames) {
      process.stdout.write(`  - ${name}\n`);
    }
    return 1;
  }
  process.stdout.write(`${bold}${green}\u2713 ${total} test(s) passed${reset}\n`);
  return 0;
}
