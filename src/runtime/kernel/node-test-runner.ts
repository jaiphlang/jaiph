import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRuntimeGraph, resolveWorkflowRef, resolveRuleRef, resolveScriptRef, type RuntimeGraph } from "./graph";
import { NodeWorkflowRuntime, type MockBodyDef } from "./node-workflow-runtime";
import type { TestBlockDef, TestStepDef } from "../../types";

type TestResult = { pass: boolean; error?: string };

type MockRefStep = Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_script" }>;

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

function writeMockDispatchScript(
  step: Extract<TestStepDef, { type: "test_mock_prompt_block" }>,
  dir: string,
): string {
  const escSh = (s: string): string => s.replace(/'/g, "'\\''");
  const lines: string[] = ["#!/usr/bin/env bash", "set -euo pipefail", 'prompt="${1:-}"'];
  let first = true;
  for (const arm of step.arms) {
    const cond = first ? "if" : "elif";
    first = false;
    if (arm.pattern.kind === "string_literal") {
      lines.push(`${cond} [[ "$prompt" == '${escSh(arm.pattern.value)}' ]]; then`);
    } else if (arm.pattern.kind === "regex") {
      lines.push(`${cond} [[ "$prompt" =~ ${arm.pattern.source} ]]; then`);
    } else {
      // wildcard — always matches; emit as else
      lines.push("else");
    }
    const response = arm.body.replace(/^["']|["']$/g, "").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    lines.push(`  printf '%s' '${escSh(response)}'`);
  }
  // If no wildcard arm, add a fallback that errors
  if (!step.arms.some((a) => a.pattern.kind === "wildcard")) {
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
  graph: RuntimeGraph,
): Promise<TestResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-test-block-"));
  try {
    const mockResponses: string[] = [];
    let mockDispatchPath = "";
    const mockRefs: Array<Extract<TestStepDef, { type: "test_mock_workflow" | "test_mock_rule" | "test_mock_script" }>> = [];
    const vars = new Map<string, string>();

    // Collect mock setup
    for (const step of block.steps) {
      if (step.type === "comment" || step.type === "blank_line") {
        continue;
      }
      if (step.type === "test_mock_prompt") {
        mockResponses.push(step.response);
      }
      if (step.type === "test_mock_prompt_block") {
        mockDispatchPath = writeMockDispatchScript(step, tmpDir);
      }
      if (step.type === "test_mock_workflow" || step.type === "test_mock_rule" || step.type === "test_mock_script") {
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
      if (step.type === "comment" || step.type === "blank_line") {
        continue;
      }
      if (step.type === "test_mock_prompt" || step.type === "test_mock_prompt_block" ||
          step.type === "test_mock_workflow" || step.type === "test_mock_rule" ||
          step.type === "test_mock_script") {
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
        // Resolve the value following production `run_capture` semantics so we can bind
        // both the explicit capture target and the implicit `response` alias.
        let runValue: string | undefined;
        if (result.status === 0 && result.returnValue) {
          runValue = result.returnValue;
        } else if (result.status !== 0 && result.error) {
          runValue = result.error.trim();
        } else if (step.captureName) {
          // No explicit return — read all .out artifact files (matches bash harness semantics).
          // Only needed when an explicit capture target requires a value.
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
        if (step.captureName && runValue !== undefined) {
          vars.set(step.captureName, runValue);
        }
        // Implicit `response` alias: bind the most recent `run` workflow's return value
        // (or captured failure output) so `expect_equal response "..."` works without
        // requiring an explicit `const response = run ...`. Last-write-wins across runs.
        if (result.status === 0 && result.returnValue !== undefined) {
          vars.set("response", result.returnValue);
        } else if (result.status !== 0 && result.error) {
          vars.set("response", result.error.trim());
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
            error: `expect_contain failed: "${step.variable}" (${value.length} chars) does not contain "${step.substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_not_contain") {
        const value = vars.get(step.variable) ?? "";
        if (value.includes(step.substring)) {
          return {
            pass: false,
            error: `expect_not_contain failed: "${step.variable}" contains "${step.substring}"`,
          };
        }
        continue;
      }

      if (step.type === "test_expect_equal") {
        const value = vars.get(step.variable) ?? "";
        if (value !== step.expected) {
          return {
            pass: false,
            error: `expect_equal failed:\n    - ${step.expected}\n    + ${value}`,
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

  // Build the runtime graph once for the entire test file.
  // The graph depends only on testFileAbs and its import closure, which are
  // constant across all blocks and steps within a single runTestFile call.
  // If a future test step mutates imported files on disk mid-run, a manual
  // rebuild would be needed — but that is not a supported pattern today.
  const graph = buildRuntimeGraph(testFileAbs, workspaceRoot);

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
