import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { WorkflowStepDef } from "../../types";
import { executePrompt, resolveConfig } from "./prompt";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";
import { resolveRuleRef, resolveScriptRef, resolveWorkflowRef, type RuntimeGraph } from "./graph";
import type { WorkflowMetadata } from "../../types";

const MAX_EMBED = 1024 * 1024;
type EnsureRecover = Extract<WorkflowStepDef, { type: "ensure" }>["recover"];

type Scope = {
  filePath: string;
  vars: Map<string, string>;
  env: NodeJS.ProcessEnv;
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

type StepIO = {
  appendOut: (chunk: string) => void;
  appendErr: (chunk: string) => void;
};

type InboxMsg = {
  channel: string;
  content: string;
  sender: string;
  seqPadded: string;
};

type WorkflowContext = {
  routes: Map<string, string[]>;
  queue: InboxMsg[];
};

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function nowIso(): string {
  return formatUtcTimestamp();
}

function interpolate(input: string, vars: Map<string, string>, env?: NodeJS.ProcessEnv): string {
  const lookup = (key: string): string => vars.get(key) ?? env?.[key] ?? "";
  return input
    .replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)\}/g, (_m, key) => lookup(String(key)))
    .replace(/\$([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)/g, (_m, key) => lookup(String(key)));
}

function parseArgsRaw(raw: string, vars: Map<string, string>, env?: NodeJS.ProcessEnv): string[] {
  if (!raw.trim()) return [];
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(interpolate(cur, vars, env));
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) {
    out.push(interpolate(cur, vars, env));
  }
  return out;
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
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
  private inboxSeq = 0;
  private workflowCtxStack: WorkflowContext[] = [];

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
    const rootScope: Scope = {
      filePath: this.graph.entryFile,
      vars: this.newScopeVars(this.graph.entryFile, undefined, this.env),
      env: this.env,
    };
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
    return this.executeManagedStep("workflow", `${workflowName}`, args, async (io) => {
      const moduleMeta = this.graph.modules.get(resolved.filePath)?.ast.metadata;
      const workflowEnv = this.applyMetadataScope(scope.env, moduleMeta, resolved.workflow.metadata);
      const childScope: Scope = {
        filePath: resolved.filePath,
        vars: this.newScopeVars(resolved.filePath, scope.vars, workflowEnv),
        env: workflowEnv,
      };
      const ctx: WorkflowContext = {
        routes: new Map(),
        queue: [],
      };
      for (const route of resolved.workflow.routes ?? []) {
        ctx.routes.set(
          route.channel,
          route.workflows.map((w) => w.value),
        );
      }
      this.workflowCtxStack.push(ctx);
      try {
        const out = await this.executeSteps(childScope, resolved.workflow.steps, io);
        if (out.status !== 0) return out;
        const drained = await this.drainWorkflowQueue(childScope, ctx);
        if (drained.status !== 0) return drained;
        return out;
      } finally {
        this.workflowCtxStack.pop();
      }
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
    return this.executeManagedStep("rule", `${ruleName}`, args, async (io) => {
      const moduleMeta = this.graph.modules.get(resolved.filePath)?.ast.metadata;
      const ruleEnv = this.applyMetadataScope(scope.env, moduleMeta);
      return this.executeSteps({ filePath: resolved.filePath, vars: new Map(scope.vars), env: ruleEnv }, resolved.rule.steps, io);
    });
  }

  private mergeStepResult(accOut: string, accErr: string, r: StepResult): StepResult {
    return {
      status: r.status,
      output: accOut + (r.output ?? ""),
      error: accErr + (r.error ?? ""),
      returnValue: r.returnValue,
    };
  }

  private async executeSteps(scope: Scope, steps: WorkflowStepDef[], io?: StepIO): Promise<StepResult> {
    let accOut = "";
    let accErr = "";
    let returnValue: string | undefined;
    for (const step of steps) {
      if (step.type === "comment") continue;
      if (step.type === "log") {
        const message = interpolate(step.message, scope.vars, scope.env);
        this.emitLog("LOG", message);
        const chunk = `${message}\n`;
        accOut += chunk;
        io?.appendOut(chunk);
        continue;
      }
      if (step.type === "logerr") {
        const message = interpolate(step.message, scope.vars, scope.env);
        this.emitLog("LOGERR", message);
        const chunk = `${message}\n`;
        accErr += chunk;
        io?.appendErr(chunk);
        continue;
      }
      if (step.type === "fail") {
        const message = interpolate(step.message, scope.vars, scope.env);
        return this.mergeStepResult(accOut, accErr, { status: 1, output: "", error: message });
      }
      if (step.type === "wait") {
        continue;
      }
      if (step.type === "shell") {
        return this.mergeStepResult(accOut, accErr, {
          status: 1,
          output: "",
          error: "inline shell steps are forbidden in Node orchestration runtime; use script blocks",
        });
      }
      if (step.type === "return") {
        returnValue = interpolate(step.value, scope.vars, scope.env);
        return this.mergeStepResult(accOut, accErr, { status: 0, output: "", error: "", returnValue });
      }
      if (step.type === "send") {
        const ctx = this.workflowCtxStack[this.workflowCtxStack.length - 1];
        if (!ctx) {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: "send is only valid inside workflow execution context",
          });
        }
        let payload = "";
        if (step.rhs.kind === "literal") {
          payload = interpolate(step.rhs.token, scope.vars, scope.env);
        } else if (step.rhs.kind === "var") {
          payload = interpolate(step.rhs.bash, scope.vars, scope.env);
        } else if (step.rhs.kind === "run") {
          const runValue = await this.executeRunRef(scope, step.rhs.ref.value, step.rhs.args ?? "");
          if (runValue.status !== 0) return this.mergeStepResult(accOut, accErr, runValue);
          payload = runValue.returnValue ?? runValue.output.trim();
        } else if (step.rhs.kind === "forward") {
          payload = scope.vars.get("1") ?? "";
        } else {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: "unsupported send rhs in node runtime",
          });
        }
        this.inboxSeq += 1;
        const seqPadded = String(this.inboxSeq).padStart(3, "0");
        const msg: InboxMsg = {
          channel: step.channel,
          content: payload,
          sender: basename(scope.filePath, ".jh"),
          seqPadded,
        };
        ctx.queue.push(msg);
        appendRunSummaryLine(
          JSON.stringify({
            type: "INBOX_ENQUEUE",
            ts: nowIso(),
            run_id: this.runId,
            channel: msg.channel,
            sender: msg.sender,
            inbox_seq: msg.seqPadded,
            event_version: 1,
          }),
        );
        continue;
      }
      if (step.type === "prompt") {
        const promptText = interpolate(step.raw, scope.vars, scope.env);
        const out = new PassThrough();
        const chunks: string[] = [];
        out.on("data", (d) => {
          const chunk = String(d);
          chunks.push(chunk);
          io?.appendOut(chunk);
        });
        const result = await executePrompt(promptText, resolveConfig(scope.env), out, scope.env);
        const output = chunks.join("");
        accOut += output;
        if (step.captureName) {
          scope.vars.set(step.captureName, result.final);
        }
        if (result.status !== 0) {
          return this.mergeStepResult(accOut, accErr, {
            status: result.status,
            output: "",
            error: "prompt failed",
          });
        }
        continue;
      }
      if (step.type === "const") {
        if (step.value.kind === "expr") {
          scope.vars.set(step.name, stripOuterQuotes(interpolate(step.value.bashRhs, scope.vars, scope.env)));
          continue;
        }
        if (step.value.kind === "run_capture") {
          const runResult = await this.executeRunRef(scope, step.value.ref.value, step.value.args ?? "");
          if (runResult.status !== 0) return this.mergeStepResult(accOut, accErr, runResult);
          scope.vars.set(step.name, runResult.returnValue ?? runResult.output.trim());
          continue;
        }
        if (step.value.kind === "ensure_capture") {
          const ensureResult = await this.executeEnsureRef(scope, step.value.ref.value, step.value.args ?? "", undefined);
          if (ensureResult.status !== 0) return this.mergeStepResult(accOut, accErr, ensureResult);
          scope.vars.set(step.name, ensureResult.returnValue ?? ensureResult.output.trim());
          continue;
        }
        if (step.value.kind === "prompt_capture") {
          const promptText = interpolate(step.value.raw, scope.vars, scope.env);
          const out = new PassThrough();
          const chunks: string[] = [];
          out.on("data", (d) => {
            const chunk = String(d);
            chunks.push(chunk);
            io?.appendOut(chunk);
          });
          const result = await executePrompt(promptText, resolveConfig(scope.env), out, scope.env);
          const pcOut = chunks.join("");
          accOut += pcOut;
          if (result.status !== 0) {
            return this.mergeStepResult(accOut, accErr, {
              status: result.status,
              output: "",
              error: "prompt failed",
            });
          }
          scope.vars.set(step.name, result.final);
          continue;
        }
      }
      if (step.type === "run") {
        const runResult = await this.executeRunRef(scope, step.workflow.value, step.args ?? "");
        if (step.captureName && runResult.status === 0) {
          scope.vars.set(step.captureName, runResult.returnValue ?? runResult.output.trim());
        }
        if (runResult.status !== 0) return this.mergeStepResult(accOut, accErr, runResult);
        continue;
      }
      if (step.type === "ensure") {
        const ensureResult = await this.executeEnsureRef(scope, step.ref.value, step.args ?? "", step.recover);
        if (step.captureName && ensureResult.status === 0) {
          scope.vars.set(step.captureName, ensureResult.returnValue ?? ensureResult.output.trim());
        }
        if (ensureResult.status !== 0) return this.mergeStepResult(accOut, accErr, ensureResult);
        continue;
      }
      if (step.type === "if") {
        const cond = step.condition.kind === "run"
          ? await this.executeRunRef(scope, step.condition.ref.value, step.condition.args ?? "")
          : await this.executeEnsureRef(scope, step.condition.ref.value, step.condition.args ?? "", undefined);
        const pass = step.negated ? cond.status !== 0 : cond.status === 0;
        if (pass) {
          const r = await this.executeSteps(scope, step.thenSteps, io);
          if (r.status !== 0 || r.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, r);
          accOut += r.output;
          accErr += r.error;
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
              const r = await this.executeSteps(scope, branch.thenSteps, io);
              if (r.status !== 0 || r.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, r);
              accOut += r.output;
              accErr += r.error;
              break;
            }
          }
          if (matched) continue;
        }
        if (step.elseSteps) {
          const r = await this.executeSteps(scope, step.elseSteps, io);
          if (r.status !== 0 || r.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, r);
          accOut += r.output;
          accErr += r.error;
        }
        continue;
      }
    }
    return { status: 0, output: accOut, error: accErr, returnValue };
  }

  private async drainWorkflowQueue(scope: Scope, ctx: WorkflowContext): Promise<StepResult> {
    let cursor = 0;
    while (cursor < ctx.queue.length) {
      const msg = ctx.queue[cursor]!;
      cursor += 1;
      const targets = ctx.routes.get(msg.channel) ?? [];
      for (const target of targets) {
        appendRunSummaryLine(
          JSON.stringify({
            type: "INBOX_DISPATCH_START",
            ts: nowIso(),
            run_id: this.runId,
            channel: msg.channel,
            sender: msg.sender,
            inbox_seq: msg.seqPadded,
            target,
            event_version: 1,
          }),
        );
        const dispatch = await this.executeRunRef(
          {
            filePath: scope.filePath,
            vars: new Map([...scope.vars, ["1", msg.content], ["2", msg.channel], ["3", msg.sender]]),
            env: scope.env,
          },
          target,
          "",
        );
        appendRunSummaryLine(
          JSON.stringify({
            type: "INBOX_DISPATCH_COMPLETE",
            ts: nowIso(),
            run_id: this.runId,
            channel: msg.channel,
            sender: msg.sender,
            inbox_seq: msg.seqPadded,
            target,
            status: dispatch.status,
            event_version: 1,
          }),
        );
        if (dispatch.status !== 0) return dispatch;
      }
    }
    return { status: 0, output: "", error: "" };
  }

  private async executeRunRef(scope: Scope, ref: string, argsRaw: string): Promise<StepResult> {
    const args = parseArgsRaw(argsRaw, scope.vars, scope.env);
    const resolvedWorkflow = resolveWorkflowRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
    if (resolvedWorkflow) return this.executeWorkflow(resolvedWorkflow.filePath, resolvedWorkflow.workflow.name, scope, args);
    const resolvedScript = resolveScriptRef(this.graph, scope.filePath, ref);
    if (!resolvedScript) return { status: 1, output: "", error: `Unknown run target: ${ref}` };
    return this.executeManagedStep(
      "script",
      ref,
      args,
      async (io) => this.executeScript(resolvedScript.filePath, resolvedScript.script.name, args, scope.env, io),
    );
  }

  private async executeEnsureRef(
    scope: Scope,
    ref: string,
    argsRaw: string,
    recover: EnsureRecover | undefined,
  ): Promise<StepResult> {
    const args = parseArgsRaw(argsRaw, scope.vars, scope.env);
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

  private async executeScript(
    filePath: string,
    scriptName: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    io?: StepIO,
  ): Promise<StepResult> {
    const scriptsDir = env.JAIPH_SCRIPTS;
    if (!scriptsDir) {
      return { status: 1, output: "", error: "JAIPH_SCRIPTS not set for script execution" };
    }
    const scriptPath = join(scriptsDir, scriptName);
    return await new Promise((resolve) => {
      const child = spawn(scriptPath, args, {
        cwd: dirname(filePath),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
        io?.appendOut(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        error += chunk;
        io?.appendErr(chunk);
      });
      child.on("error", (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        error += msg;
        io?.appendErr(msg);
        resolve({
          status: 1,
          output,
          error,
          returnValue: output.trim(),
        });
      });
      child.on("close", (code) => {
        resolve({
          status: typeof code === "number" ? code : 1,
          output,
          error,
          returnValue: output.trim(),
        });
      });
    });
  }

  private newScopeVars(filePath: string, parent?: Map<string, string>, env?: NodeJS.ProcessEnv): Map<string, string> {
    const vars = new Map<string, string>(parent ? Array.from(parent.entries()) : []);
    const node = this.graph.modules.get(filePath);
    if (!node) return vars;
    for (const envDecl of node.ast.envDecls ?? []) {
      vars.set(envDecl.name, interpolate(envDecl.value, vars, env ?? this.env));
    }
    return vars;
  }

  private applyMetadataScope(
    parentEnv: NodeJS.ProcessEnv,
    moduleMeta?: WorkflowMetadata,
    workflowMeta?: WorkflowMetadata,
  ): NodeJS.ProcessEnv {
    const nextEnv: NodeJS.ProcessEnv = { ...parentEnv };
    const apply = (meta?: WorkflowMetadata): void => {
      if (!meta) return;
      if (parentEnv.JAIPH_AGENT_MODEL_LOCKED !== "1" && meta.agent?.defaultModel !== undefined) {
        nextEnv.JAIPH_AGENT_MODEL = meta.agent.defaultModel;
      }
      if (parentEnv.JAIPH_AGENT_COMMAND_LOCKED !== "1" && meta.agent?.command !== undefined) {
        nextEnv.JAIPH_AGENT_COMMAND = meta.agent.command;
      }
      if (parentEnv.JAIPH_AGENT_BACKEND_LOCKED !== "1" && meta.agent?.backend !== undefined) {
        nextEnv.JAIPH_AGENT_BACKEND = meta.agent.backend;
      }
      if (
        parentEnv.JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED !== "1" &&
        meta.agent?.trustedWorkspace !== undefined
      ) {
        nextEnv.JAIPH_AGENT_TRUSTED_WORKSPACE = meta.agent.trustedWorkspace;
      }
      if (parentEnv.JAIPH_AGENT_CURSOR_FLAGS_LOCKED !== "1" && meta.agent?.cursorFlags !== undefined) {
        nextEnv.JAIPH_AGENT_CURSOR_FLAGS = meta.agent.cursorFlags;
      }
      if (parentEnv.JAIPH_AGENT_CLAUDE_FLAGS_LOCKED !== "1" && meta.agent?.claudeFlags !== undefined) {
        nextEnv.JAIPH_AGENT_CLAUDE_FLAGS = meta.agent.claudeFlags;
      }
      if (parentEnv.JAIPH_RUNS_DIR_LOCKED !== "1" && meta.run?.logsDir !== undefined) {
        nextEnv.JAIPH_RUNS_DIR = meta.run.logsDir;
      }
      if (parentEnv.JAIPH_DEBUG_LOCKED !== "1" && meta.run?.debug !== undefined) {
        nextEnv.JAIPH_DEBUG = meta.run.debug ? "true" : "false";
      }
      if (parentEnv.JAIPH_INBOX_PARALLEL_LOCKED !== "1" && meta.run?.inboxParallel !== undefined) {
        nextEnv.JAIPH_INBOX_PARALLEL = meta.run.inboxParallel ? "true" : "false";
      }
    };
    apply(moduleMeta);
    apply(workflowMeta);
    return nextEnv;
  }

  private async executeManagedStep(
    kind: "workflow" | "rule" | "script",
    name: string,
    args: string[],
    fn: (io: StepIO) => Promise<StepResult>,
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
    writeFileSync(outFile, "");
    writeFileSync(errFile, "");
    const io: StepIO = {
      appendOut: (chunk: string) => {
        if (chunk.length > 0) appendFileSync(outFile, chunk);
      },
      appendErr: (chunk: string) => {
        if (chunk.length > 0) appendFileSync(errFile, chunk);
      },
    };
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
    const result = await fn(io);
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
