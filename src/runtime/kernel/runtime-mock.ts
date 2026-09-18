/**
 * Mock-body execution for `*.test.jh` workflow/rule/script mocks.
 *
 * Shell-kind mocks run `bash -c` in the runtime's working directory with the
 * mock's parameter names exposed as env vars. Steps-kind mocks dispatch back
 * into the runtime via `executeStepsBack` so that the mock body runs against
 * the runtime's full step interpreter.
 */
import { spawnSync } from "node:child_process";
import type { StepDef } from "../../types";

/** Mock body definition: shell for script mocks, Jaiph steps for workflow/rule mocks. */
export type MockBodyDef =
  | { kind: "shell"; body: string; params: string[] }
  | { kind: "steps"; steps: StepDef[]; params: string[] };

export type StepResult = {
  status: number;
  /**
   * In-memory stdout copy. Populated for defs (accumulated `log` lines) and
   * mock bodies, but left empty for a leaf `script`/inline-script subprocess:
   * its stdout is streamed straight to `outFile` on disk and never held in a
   * JS string (see the output-handle model — a call result keeps its bytes on
   * disk until a force site slurps them). Read the forced value through
   * `forceValue`, not this field.
   */
  output: string;
  error: string;
  returnValue?: string;
  /**
   * The file whose bytes are this result's forced value when `returnValue` is
   * unset — the "output handle" byte source. For a leaf script it is the
   * step's own stdout capture; for a def that did `return <call>()` it is the
   * callee's `valueFile`, propagated up so `stdin wrap() -> sink()` streams the
   * bytes and `const y = wrap()` slurps them. Absent when `returnValue` holds
   * an eager string (def `return "…"`, prompt answer, match value).
   */
  valueFile?: string;
  /**
   * True when the leaf subprocess already streamed its stdout/stderr to
   * `outFile`/`errFile` (via `spawnAndCapture`'s `io`), so `executeManagedStep`
   * must not overwrite those files from the empty in-memory `output`.
   */
  streamed?: boolean;
  /** Set when a catch body executed a `return` statement. */
  recoverReturn?: boolean;
  /**
   * Absolute path of this step's stdout capture (`NNNNNN-*.out` under
   * `JAIPH_RUN_DIR`), stamped by `executeManagedStep`. The sibling `.err`
   * (`errFile`, same seq prefix) holds stderr. Absent on results that never
   * ran as a managed step (e.g. an unresolved run target).
   */
  outFile?: string;
  errFile?: string;
};

/**
 * Execute a steps-kind mock body. Builds a fresh scope rooted at `entryFile`
 * with `params`/`args` bound, then defers to the runtime's step executor.
 */
export type ExecuteStepsBack = (
  params: string[],
  args: string[],
  steps: StepDef[],
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
