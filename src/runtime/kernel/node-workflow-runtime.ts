import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { WorkflowStepDef } from "../../types";
import { executePrompt, resolveConfig } from "./prompt";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";
import { resolveRuleRef, resolveScriptRef, resolveWorkflowRef, type RuntimeGraph } from "./graph";

const MAX_EMBED = 1024 * 1024;
type EnsureRecover = Extract<WorkflowStepDef, { type: "ensure" }>["recover"];

type Scope = {
  filePath: string;
  vars: Map<string, string>;
};

type Frame = {
  id: string;
  kind: string;
  name: string;
};

type StepResult = {
  status: number;
  output: string;
  error: string;
  returnValue?: string;
};

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function nowIso(): string {
  return formatUtcTimestamp();
}

function interpolate(input: string, vars: Map<string, string>): string {
  return input
    .replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, key) => vars.get(key) ?? "")
    .replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key) => vars.get(key) ?? "");
}

export class NodeWorkflowRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly graph: RuntimeGraph;
  private readonly runId: string;
  private readonly runDir: string;
  private readonly summaryFile: string;
  private stepSeq = 0;
  private stack: Frame[] = [];

  constructor(graph: RuntimeGraph, opts: { env?: NodeJS.ProcessEnv; cwd?: string }) {
    this.graph = graph;
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? process.cwd();
    this.runId = randomUUID();
    const source = this.env.JAIPH_SOURCE_FILE ?? basename(graph.entryFile);
    const date = new Date();
    const datePart = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const timePart = `${String(date.getUTCHours()).padStart(2, "0")}-${String(date.getUTCMinutes()).padStart(2, "0")}-${String(date.getUTCSeconds()).padStart(2, "0")}`;
    const runsRoot = this.resolveRunsRoot();
    this.runDir = join(runsRoot, datePart, `${timePart}-${source}`);
    mkdirSync(this.runDir, { recursive: true });
    this.summaryFile = join(this.runDir, "run_summary.jsonl");
    writeFileSync(this.summaryFile, "");
    this.env.JAIPH_RUN_SUMMARY_FILE = this.summaryFile;
    this.env.JAIPH_RUN_ID = this.runId;
    this.env.JAIPH_RUN_DIR = this.runDir;
  }

  getRunDir(): string {
    return this.runDir;
  }

  getSummaryFile(): string {
    return this.summaryFile;
  }

  async runDefault(args: string[]): Promise<number> {
    this.emitWorkflow("WORKFLOW_START", "default");
    const rootScope: Scope = { filePath: this.graph.entryFile, vars: new Map<string, string>() };
    args.forEach((v, i) => {
      rootScope.vars.set(String(i + 1), v);
      rootScope.vars.set(`arg${i + 1}`, v);
    });
    const resolved = resolveWorkflowRef(this.graph, this.graph.entryFile, {
      value: "default",
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      process.stderr.write("jaiph run requires workflow 'default' in the input file\n");
      this.emitWorkflow("WORKFLOW_END", "default");
      return 1;
    }
    const result = await this.executeWorkflow(resolved.filePath, resolved.workflow.name, rootScope, args);
    this.emitWorkflow("WORKFLOW_END", "default");
    return result.status;
  }

  private resolveRunsRoot(): string {
    const configured = this.env.JAIPH_RUNS_DIR;
    if (configured && configured.length > 0) {
      if (configured.startsWith("/")) return configured;
      return join(this.cwd, configured);
    }
    return join(this.cwd, ".jaiph", "runs");
  }

  private emitWorkflow(type: "WORKFLOW_START" | "WORKFLOW_END", workflow: string): void {
    appendRunSummaryLine(
      JSON.stringify({
        type,
        workflow,
        source: this.env.JAIPH_SOURCE_FILE ?? "",
        ts: nowIso(),
        run_id: this.runId,
        event_version: 1,
      }),
    );
  }

  private emitLog(type: "LOG" | "LOGERR", message: string): void {
    const payload = {
      type,
      message,
      depth: this.stack.length,
      ts: nowIso(),
      run_id: this.runId,
      event_version: 1,
    };
    process.stderr.write(`__JAIPH_EVENT__ ${JSON.stringify({ type, message, depth: this.stack.length })}\n`);
    appendRunSummaryLine(JSON.stringify(payload));
  }

  private async executeWorkflow(filePath: string, workflowName: string, scope: Scope, args: string[]): Promise<StepResult> {
    const resolved = resolveWorkflowRef(this.graph, filePath, {
      value: workflowName,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      return { status: 1, output: "", error: `Unknown workflow: ${workflowName}` };
    }
    return this.executeManagedStep("workflow", `${workflowName}`, args, async () => {
      return this.executeSteps({ filePath: resolved.filePath, vars: new Map(scope.vars) }, resolved.workflow.steps);
    });
  }

  private async executeRule(filePath: string, ruleName: string, scope: Scope, args: string[]): Promise<StepResult> {
    const resolved = resolveRuleRef(this.graph, filePath, {
      value: ruleName,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      return { status: 1, output: "", error: `Unknown rule: ${ruleName}` };
    }
    return this.executeManagedStep("rule", `${ruleName}`, args, async () => {
      return this.executeSteps({ filePath: resolved.filePath, vars: new Map(scope.vars) }, resolved.rule.steps);
    });
  }

  private async executeSteps(scope: Scope, steps: WorkflowStepDef[]): Promise<StepResult> {
    let returnValue: string | undefined;
    for (const step of steps) {
      if (step.type === "comment") continue;
      if (step.type === "log") {
        const message = interpolate(step.message, scope.vars);
        this.emitLog("LOG", message);
        process.stdout.write(`${message}\n`);
        continue;
      }
      if (step.type === "logerr") {
        const message = interpolate(step.message, scope.vars);
        this.emitLog("LOGERR", message);
        process.stderr.write(`${message}\n`);
        continue;
      }
      if (step.type === "fail") {
        const message = interpolate(step.message, scope.vars);
        return { status: 1, output: "", error: message };
      }
      if (step.type === "wait") {
        continue;
      }
      if (step.type === "shell") {
        return {
          status: 1,
          output: "",
          error: "inline shell steps are forbidden in Node orchestration runtime; use script blocks",
        };
      }
      if (step.type === "return") {
        returnValue = interpolate(step.value, scope.vars);
        return { status: 0, output: "", error: "", returnValue };
      }
      if (step.type === "send") {
        const payload =
          step.rhs.kind === "literal"
            ? interpolate(step.rhs.token, scope.vars)
            : step.rhs.kind === "var"
              ? interpolate(step.rhs.bash, scope.vars)
              : "";
        const inboxJs = this.env.JAIPH_INBOX_JS;
        if (!inboxJs || !existsSync(inboxJs)) {
          return { status: 1, output: "", error: "JAIPH_INBOX_JS not available for send step" };
        }
        const r = spawnSync(process.execPath, [inboxJs, "send", step.channel, payload, "runtime"], {
          cwd: this.cwd,
          env: this.env,
          encoding: "utf8",
        });
        if ((r.status ?? 1) !== 0) {
          return { status: r.status ?? 1, output: r.stdout ?? "", error: r.stderr ?? "send failed" };
        }
        continue;
      }
      if (step.type === "prompt") {
        const promptText = interpolate(step.raw, scope.vars);
        const out = new PassThrough();
        const chunks: string[] = [];
        out.on("data", (d) => chunks.push(String(d)));
        const result = await executePrompt(promptText, resolveConfig(), out);
        const output = chunks.join("");
        if (step.captureName) {
          scope.vars.set(step.captureName, result.final);
        }
        if (result.status !== 0) {
          return { status: result.status, output, error: "prompt failed" };
        }
        continue;
      }
      if (step.type === "const") {
        if (step.value.kind === "expr") {
          scope.vars.set(step.name, interpolate(step.value.bashRhs, scope.vars));
          continue;
        }
        if (step.value.kind === "run_capture") {
          const runResult = await this.executeRunRef(scope, step.value.ref.value, step.value.args ?? "");
          if (runResult.status !== 0) return runResult;
          scope.vars.set(step.name, runResult.returnValue ?? runResult.output.trim());
          continue;
        }
        if (step.value.kind === "ensure_capture") {
          const ensureResult = await this.executeEnsureRef(scope, step.value.ref.value, step.value.args ?? "", undefined);
          if (ensureResult.status !== 0) return ensureResult;
          scope.vars.set(step.name, ensureResult.returnValue ?? ensureResult.output.trim());
          continue;
        }
        if (step.value.kind === "prompt_capture") {
          const promptText = interpolate(step.value.raw, scope.vars);
          const out = new PassThrough();
          const chunks: string[] = [];
          out.on("data", (d) => chunks.push(String(d)));
          const result = await executePrompt(promptText, resolveConfig(), out);
          if (result.status !== 0) return { status: result.status, output: chunks.join(""), error: "prompt failed" };
          scope.vars.set(step.name, result.final);
          continue;
        }
      }
      if (step.type === "run") {
        const runResult = await this.executeRunRef(scope, step.workflow.value, step.args ?? "");
        if (step.captureName && runResult.status === 0) {
          scope.vars.set(step.captureName, runResult.returnValue ?? runResult.output.trim());
        }
        if (runResult.status !== 0) return runResult;
        continue;
      }
      if (step.type === "ensure") {
        const ensureResult = await this.executeEnsureRef(scope, step.ref.value, step.args ?? "", step.recover);
        if (step.captureName && ensureResult.status === 0) {
          scope.vars.set(step.captureName, ensureResult.returnValue ?? ensureResult.output.trim());
        }
        if (ensureResult.status !== 0) return ensureResult;
        continue;
      }
      if (step.type === "if") {
        const cond = step.condition.kind === "run"
          ? await this.executeRunRef(scope, step.condition.ref.value, step.condition.args ?? "")
          : await this.executeEnsureRef(scope, step.condition.ref.value, step.condition.args ?? "", undefined);
        const pass = step.negated ? cond.status !== 0 : cond.status === 0;
        if (pass) {
          const r = await this.executeSteps(scope, step.thenSteps);
          if (r.status !== 0 || r.returnValue !== undefined) return r;
          continue;
        }
        if (step.elseIfBranches) {
          let matched = false;
          for (const branch of step.elseIfBranches) {
            const bcond = branch.condition.kind === "run"
              ? await this.executeRunRef(scope, branch.condition.ref.value, branch.condition.args ?? "")
              : await this.executeEnsureRef(scope, branch.condition.ref.value, branch.condition.args ?? "", undefined);
            const bpass = branch.negated ? bcond.status !== 0 : bcond.status === 0;
            if (bpass) {
              matched = true;
              const r = await this.executeSteps(scope, branch.thenSteps);
              if (r.status !== 0 || r.returnValue !== undefined) return r;
              break;
            }
          }
          if (matched) continue;
        }
        if (step.elseSteps) {
          const r = await this.executeSteps(scope, step.elseSteps);
          if (r.status !== 0 || r.returnValue !== undefined) return r;
        }
        continue;
      }
    }
    return { status: 0, output: "", error: "", returnValue };
  }

  private async executeRunRef(scope: Scope, ref: string, argsRaw: string): Promise<StepResult> {
    const args = argsRaw.length > 0 ? argsRaw.split(/\s+/).map((a) => interpolate(a, scope.vars)) : [];
    const resolvedWorkflow = resolveWorkflowRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
    if (resolvedWorkflow) return this.executeWorkflow(resolvedWorkflow.filePath, resolvedWorkflow.workflow.name, scope, args);
    const resolvedScript = resolveScriptRef(this.graph, scope.filePath, ref);
    if (!resolvedScript) return { status: 1, output: "", error: `Unknown run target: ${ref}` };
    return this.executeManagedStep("script", ref, args, async () => this.executeScript(resolvedScript.filePath, resolvedScript.script.name, args));
  }

  private async executeEnsureRef(
    scope: Scope,
    ref: string,
    argsRaw: string,
    recover: EnsureRecover | undefined,
  ): Promise<StepResult> {
    const args = argsRaw.length > 0 ? argsRaw.split(/\s+/).map((a) => interpolate(a, scope.vars)) : [];
    const attempt = async (): Promise<StepResult> => {
      const resolvedRule = resolveRuleRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
      if (!resolvedRule) return { status: 1, output: "", error: `Unknown ensure target: ${ref}` };
      return this.executeRule(resolvedRule.filePath, resolvedRule.rule.name, scope, args);
    };
    if (!recover) return attempt();
    const maxRetries = Number(this.env.JAIPH_ENSURE_MAX_RETRIES ?? "3");
    for (let i = 0; i < maxRetries; i += 1) {
      const res = await attempt();
      if (res.status === 0) return res;
      const recoverSteps = "single" in recover ? [recover.single] : recover.block;
      const rr = await this.executeSteps(scope, recoverSteps);
      if (rr.status !== 0) return rr;
    }
    return { status: 1, output: "", error: `ensure ${ref} failed after ${maxRetries} retries` };
  }

  private async executeScript(filePath: string, scriptName: string, args: string[]): Promise<StepResult> {
    const scriptsDir = this.env.JAIPH_SCRIPTS;
    if (!scriptsDir) {
      return { status: 1, output: "", error: "JAIPH_SCRIPTS not set for script execution" };
    }
    const scriptPath = join(scriptsDir, scriptName);
    const r = spawnSync(scriptPath, args, {
      cwd: dirname(filePath),
      env: this.env,
      encoding: "utf8",
    });
    return {
      status: r.status ?? 1,
      output: r.stdout ?? "",
      error: r.stderr ?? "",
      returnValue: (r.stdout ?? "").trim(),
    };
  }

  private async executeManagedStep(
    kind: "workflow" | "rule" | "script",
    name: string,
    args: string[],
    fn: () => Promise<StepResult>,
  ): Promise<StepResult> {
    this.stepSeq += 1;
    const seq = this.stepSeq;
    const safe = sanitizeName(`${kind}__${name}`);
    const outFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.out`);
    const errFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.err`);
    const parentId = this.stack.length > 0 ? this.stack[this.stack.length - 1]!.id : null;
    const id = `${this.runId}:${process.pid}:${seq}`;
    const depth = this.stack.length;
    const frame: Frame = { id, kind, name };
    this.stack.push(frame);
    this.emitStep({
      type: "STEP_START",
      func: name,
      kind,
      name,
      ts: nowIso(),
      status: null,
      elapsed_ms: null,
      out_file: outFile,
      err_file: errFile,
      id,
      parent_id: parentId,
      seq,
      depth,
      run_id: this.runId,
      params: args.map((v, i) => [`arg${i + 1}`, v]),
    });
    const started = Date.now();
    const result = await fn();
    const elapsed = Date.now() - started;
    writeFileSync(outFile, result.output ?? "");
    writeFileSync(errFile, result.error ?? "");
    this.emitStep({
      type: "STEP_END",
      func: name,
      kind,
      name,
      ts: nowIso(),
      status: result.status,
      elapsed_ms: elapsed,
      out_file: outFile,
      err_file: errFile,
      id,
      parent_id: parentId,
      seq,
      depth,
      run_id: this.runId,
      params: args.map((v, i) => [`arg${i + 1}`, v]),
      out_content: (result.output ?? "").slice(0, MAX_EMBED),
      err_content: result.status !== 0 ? (result.error ?? "").slice(0, MAX_EMBED) : "",
    });
    this.stack.pop();
    return result;
  }

  private emitStep(payload: Record<string, unknown>): void {
    process.stderr.write(`__JAIPH_EVENT__ ${JSON.stringify(payload)}\n`);
    appendRunSummaryLine(JSON.stringify({ ...payload, event_version: 1 }));
  }
}
