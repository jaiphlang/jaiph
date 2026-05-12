/**
 * Mock-body execution for `*.test.jh` workflow/rule/script mocks.
 *
 * Shell-kind mocks run `bash -c` in the runtime's working directory with the
 * mock's parameter names exposed as env vars. Steps-kind mocks dispatch back
 * into the runtime via `executeStepsBack` so that the mock body runs against
 * the runtime's full step interpreter.
 */
import { spawnSync } from "node:child_process";
import type { WorkflowStepDef } from "../../types";

/** Mock body definition: shell for script mocks, Jaiph steps for workflow/rule mocks. */
export type MockBodyDef =
  | { kind: "shell"; body: string; params: string[] }
  | { kind: "steps"; steps: WorkflowStepDef[]; params: string[] };

export type StepResult = {
  status: number;
  output: string;
  error: string;
  returnValue?: string;
  /** Set when a catch body executed a `return` statement. */
  recoverReturn?: boolean;
};

/**
 * Execute a steps-kind mock body. Builds a fresh scope rooted at `entryFile`
 * with `params`/`args` bound, then defers to the runtime's step executor.
 */
export type ExecuteStepsBack = (
  params: string[],
  args: string[],
  steps: WorkflowStepDef[],
) => Promise<StepResult>;

export async function executeMockBodyDef(deps: {
  ref: string;
  mockDef: MockBodyDef;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  executeStepsBack: ExecuteStepsBack;
}): Promise<StepResult> {
  const { mockDef, args, env, cwd, executeStepsBack } = deps;
  if (mockDef.kind === "shell") {
    return executeMockShellBody({ body: mockDef.body, args, params: mockDef.params, env, cwd });
  }
  return executeStepsBack(mockDef.params, args, mockDef.steps);
}

export function executeMockShellBody(deps: {
  body: string;
  args: string[];
  params: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}): StepResult {
  const { body, args, params, env, cwd } = deps;
  const childEnv = { ...env };
  params.forEach((name, i) => {
    if (i < args.length) childEnv[name] = args[i];
  });
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`, "mock", ...args], {
    encoding: "utf8",
    cwd,
    env: childEnv,
  });
  const status = r.status ?? 1;
  const output = r.stdout ?? "";
  return {
    status,
    output,
    error: r.stderr ?? "",
    ...(status === 0 ? { returnValue: output.trim() } : {}),
  };
}
