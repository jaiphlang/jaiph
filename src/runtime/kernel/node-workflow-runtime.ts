import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inlineScriptName } from "../../inline-script-name";
import type { MatchExprDef, WorkflowStepDef } from "../../types";
import { executePrompt, resolveConfig, resolveModel, resolvePromptStepName } from "./prompt";
import { appendRunSummaryLine, formatUtcTimestamp } from "./emit";
import { buildStepDisplayParamPairs } from "../../cli/commands/format-params.js";
import { resolveRuleRef, resolveScriptRef, resolveWorkflowRef, type RuntimeGraph } from "./graph";
import type { WorkflowMetadata } from "../../types";
import { extractJson, validateFields } from "./schema";

const MAX_EMBED = 1024 * 1024;
type EnsureRecover = Extract<WorkflowStepDef, { type: "ensure" }>["recover"];

/** Mock body definition: shell for script mocks, Jaiph steps for workflow/rule mocks. */
export type MockBodyDef =
  | { kind: "shell"; body: string; params: string[] }
  | { kind: "steps"; steps: WorkflowStepDef[]; params: string[] };

type Scope = {
  filePath: string;
  vars: Map<string, string>;
  env: NodeJS.ProcessEnv;
  /** Declared parameter names for the active workflow or rule. */
  declaredParamNames?: string[];
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
  workflowName: string;
  routes: Map<string, string[]>;
  queue: InboxMsg[];
};

type PromptSchemaField = { name: string; type: "string" | "number" | "boolean" };
type PromptStepHandle = {
  id: string;
  seq: number;
  outFile: string;
  errFile: string;
  backend: string;
  startedAtMs: number;
};

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function nowIso(): string {
  return formatUtcTimestamp();
}

function interpolate(input: string, vars: Map<string, string>, env?: NodeJS.ProcessEnv): string {
  const lookup = (key: string): string => vars.get(key) ?? env?.[key] ?? "";
  return input.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\}/g, (_m, base, field) => {
    const key = field ? `${base}_${field}` : String(base);
    return lookup(key);
  });
}

/** Body after "run" / "ensure" in ${run ...} / ${ensure ...} (e.g. greet(), greet(x), or greet x). */
function parseInlineCaptureCall(body: string): { ref: string; argsRaw: string } {
  const trimmed = body.trim();
  const paren = trimmed.match(/^([\w.]+)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    return { ref: paren[1], argsRaw: paren[2].trim() };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { ref: trimmed, argsRaw: "" };
  }
  return { ref: trimmed.slice(0, spaceIdx), argsRaw: trimmed.slice(spaceIdx + 1).trim() };
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

function parsePromptSchema(rawSchema: string): PromptSchemaField[] {
  const trimmed = rawSchema.trim();
  if (trimmed.length === 0) return [];
  if (/[[\]|]/.test(trimmed)) {
    throw new Error("returns schema must be flat (no arrays or union types)");
  }
  const inner = trimmed.replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (inner.length === 0) return [];
  const fields: PromptSchemaField[] = [];
  for (const part of inner.split(",")) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)\s*$/);
    if (!m) {
      throw new Error(`invalid returns schema entry: ${part.trim().slice(0, 40)}`);
    }
    const [, name, typeStr] = m;
    const type = typeStr.toLowerCase();
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new Error(`unsupported returns schema type: ${typeStr}`);
    }
    fields.push({ name, type: type as "string" | "number" | "boolean" });
  }
  return fields;
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
  private asyncFrameStack = new AsyncLocalStorage<Frame[]>();
  private asyncIndicesStorage = new AsyncLocalStorage<number[]>();
  private inboxSeq = 0;
  private promptSeq = 0;
  private workflowCtxStack: WorkflowContext[] = [];
  private readonly mockBodies: Map<string, MockBodyDef>;

  private getFrameStack(): Frame[] {
    return this.asyncFrameStack.getStore() ?? this.stack;
  }

  private getAsyncIndices(): number[] {
    return this.asyncIndicesStorage.getStore() ?? [];
  }

  constructor(graph: RuntimeGraph, opts: { env?: NodeJS.ProcessEnv; cwd?: string; mockBodies?: Map<string, MockBodyDef> }) {
    this.graph = graph;
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? process.cwd();
    this.mockBodies = opts.mockBodies ?? new Map();
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
    const workspaceForLib = this.env.JAIPH_WORKSPACE ?? this.cwd;
    if (this.env.JAIPH_LIB === undefined || this.env.JAIPH_LIB === "") {
      this.env.JAIPH_LIB = join(workspaceForLib, ".jaiph", "lib");
    }
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
      env: { ...this.env },
    };
    const resolved = resolveWorkflowRef(this.graph, this.graph.entryFile, {
      value: "default",
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      process.stderr.write("jaiph run requires workflow 'default' in the input file\n");
      this.emitWorkflow("WORKFLOW_END", "default");
      return 1;
    }
    // Bind CLI args to declared parameter names by position.
    resolved.workflow.params.forEach((name, i) => {
      if (i < args.length) rootScope.vars.set(name, args[i]);
    });
    const result = await this.executeWorkflow(resolved.filePath, resolved.workflow.name, rootScope, args, false);
    this.emitWorkflow("WORKFLOW_END", "default");
    return result.status;
  }

  async runNamedWorkflow(ref: string, args: string[]): Promise<{ status: number; output: string; error?: string; returnValue?: string }> {
    const rootScope: Scope = {
      filePath: this.graph.entryFile,
      vars: this.newScopeVars(this.graph.entryFile, undefined, this.env),
      env: { ...this.env },
    };
    const resolved = resolveWorkflowRef(this.graph, this.graph.entryFile, {
      value: ref,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      return { status: 1, output: `Unknown workflow: ${ref}` };
    }
    // Bind args to declared parameter names by position.
    resolved.workflow.params.forEach((name, i) => {
      if (i < args.length) rootScope.vars.set(name, args[i]);
    });
    const result = await this.executeWorkflow(resolved.filePath, resolved.workflow.name, rootScope, args, false);
    return { status: result.status, output: result.output, error: result.error, returnValue: result.returnValue };
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

  private emitPromptEvent(
    type: "PROMPT_START" | "PROMPT_END",
    payload: { backend: string; model?: string; model_reason?: string; status?: number; preview?: string },
  ): void {
    const stack = this.getFrameStack();
    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    appendRunSummaryLine(
      JSON.stringify({
        type,
        ts: nowIso(),
        run_id: this.runId,
        depth: stack.length,
        step_id: current?.id ?? null,
        step_name: current?.name ?? null,
        backend: payload.backend,
        model: payload.model ?? null,
        model_reason: payload.model_reason ?? null,
        status: payload.status ?? null,
        preview: payload.preview ?? null,
        event_version: 1,
      }),
    );
  }

  private emitPromptStepStart(
    promptText: string,
    backend: string,
    scopeVars: Map<string, string>,
    rawPromptSource: string,
    declaredParamNames?: string[],
  ): PromptStepHandle {
    this.promptSeq += 1;
    this.stepSeq += 1;
    const stack = this.getFrameStack();
    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    const id = `${this.runId}:${process.pid}:prompt:${this.promptSeq}`;
    const seq = this.stepSeq;
    const safe = sanitizeName("prompt__prompt");
    const outFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.out`);
    const errFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.err`);
    writeFileSync(outFile, "");
    writeFileSync(errFile, "");
    const preview = stripOuterQuotes(promptText).replace(/\s+/g, " ").trim();
    const params: Array<[string, string]> = [["prompt_text", preview]];
    const seen = new Set<string>(["prompt_text"]);
    // Include named vars referenced in the prompt text.
    const refRe = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(rawPromptSource)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        const val = scopeVars.get(name) ?? "";
        if (val.length > 0) params.push([name, val]);
      }
    }
    if (declaredParamNames) {
      for (const pn of declaredParamNames) {
        if (!seen.has(pn)) {
          const val = scopeVars.get(pn) ?? "";
          if (val.length > 0) {
            seen.add(pn);
            params.push([pn, val]);
          }
        }
      }
    }
    this.emitStep({
      type: "STEP_START",
      func: "prompt",
      kind: "prompt",
      name: backend,
      ts: nowIso(),
      status: null,
      elapsed_ms: null,
      out_file: outFile,
      err_file: errFile,
      id,
      parent_id: current?.id ?? null,
      seq,
      depth: stack.length,
      run_id: this.runId,
      params,
    });
    return { id, seq, outFile, errFile, backend, startedAtMs: Date.now() };
  }

  private emitPromptStepEnd(prompt: PromptStepHandle, status: number, outContent: string, errContent: string): void {
    const stack = this.getFrameStack();
    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    if (errContent.length > 0) {
      writeFileSync(prompt.errFile, errContent);
    }
    this.emitStep({
      type: "STEP_END",
      func: "prompt",
      kind: "prompt",
      name: prompt.backend,
      ts: nowIso(),
      status,
      elapsed_ms: Date.now() - prompt.startedAtMs,
      out_file: prompt.outFile,
      err_file: prompt.errFile,
      id: prompt.id,
      parent_id: current?.id ?? null,
      seq: prompt.seq,
      depth: stack.length,
      run_id: this.runId,
      params: [],
      out_content: outContent.slice(0, MAX_EMBED),
      err_content: status !== 0 ? errContent.slice(0, MAX_EMBED) : "",
    });
  }

  private emitLog(type: "LOG" | "LOGERR", message: string): void {
    const depth = this.getFrameStack().length;
    const indices = this.getAsyncIndices();
    const liveBase: Record<string, unknown> = { type, message, depth };
    if (indices.length > 0) liveBase.async_indices = indices;
    const payload = {
      ...liveBase,
      ts: nowIso(),
      run_id: this.runId,
      event_version: 1,
    };
    if (this.env.JAIPH_TEST_MODE !== "1") {
      process.stderr.write(`__JAIPH_EVENT__ ${JSON.stringify(liveBase)}\n`);
    }
    appendRunSummaryLine(JSON.stringify(payload));
  }

  private async executeWorkflow(
    filePath: string,
    workflowName: string,
    scope: Scope,
    args: string[],
    inheritCallerMetadataScope: boolean,
  ): Promise<StepResult> {
    const resolved = resolveWorkflowRef(this.graph, filePath, {
      value: workflowName,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      return { status: 1, output: "", error: `Unknown workflow: ${workflowName}` };
    }
    const callerModulePath = resolvePath(scope.filePath);
    const calleeModulePath = resolvePath(resolved.filePath);
    const crossModuleNested = callerModulePath !== calleeModulePath;
    return this.executeManagedStep("workflow", `${workflowName}`, args, async (io) => {
      // Root entry (`runDefault`, inheritCallerMetadataScope=false): apply entry module + workflow metadata.
      // Nested cross-module (`run` / inbox to another module): caller env (locks + effective scope)
      // is authoritative — do not layer callee module or callee workflow metadata.
      // Same-module nested `run` (inheritCallerMetadataScope=true, !crossModuleNested): apply callee
      // workflow-level config on top of caller env (workflow boundaries still apply within one module).
      let workflowEnv: NodeJS.ProcessEnv;
      if (inheritCallerMetadataScope && crossModuleNested) {
        workflowEnv = { ...scope.env };
      } else if (inheritCallerMetadataScope) {
        workflowEnv = this.applyMetadataScope(scope.env, undefined, resolved.workflow.metadata);
      } else {
        workflowEnv = this.applyMetadataScope(
          scope.env,
          this.graph.modules.get(resolved.filePath)?.ast.metadata,
          resolved.workflow.metadata,
        );
      }
      const childScope: Scope = {
        filePath: resolved.filePath,
        vars: this.newScopeVars(resolved.filePath, scope.vars, workflowEnv),
        env: workflowEnv,
        declaredParamNames: resolved.workflow.params,
      };
      resolved.workflow.params.forEach((name, i) => {
        if (i < args.length) childScope.vars.set(name, args[i]);
      });
      const ctx: WorkflowContext = {
        workflowName,
        routes: new Map(),
        queue: [],
      };
      // Build route map from channel-level route declarations in the module.
      // Only register on the entry workflow (not nested calls) so that sends from
      // nested workflows bubble up to the orchestrator for dispatch, preserving
      // the expected progress tree nesting.
      if (!inheritCallerMetadataScope) {
        const moduleAst = this.graph.modules.get(resolved.filePath)?.ast;
        if (moduleAst) {
          for (const ch of moduleAst.channels) {
            if (ch.routes && ch.routes.length > 0) {
              ctx.routes.set(ch.name, ch.routes.map((r) => r.value));
            }
          }
        }
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
    }, resolved.workflow.params);
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
      // Same-module rules inherit the calling scope's effective env (which already
      // includes module + workflow metadata).  Only apply callee module metadata
      // for cross-module rule references so we don't overwrite workflow-level overrides.
      const sameModule = resolvePath(scope.filePath) === resolvePath(resolved.filePath);
      const moduleMeta = sameModule ? undefined : this.graph.modules.get(resolved.filePath)?.ast.metadata;
      const ruleEnv = this.applyMetadataScope(scope.env, moduleMeta);
      const ruleVars = new Map(scope.vars);
      resolved.rule.params.forEach((name, i) => {
        if (i < args.length) ruleVars.set(name, args[i]);
      });
      return this.executeSteps(
        {
          filePath: resolved.filePath,
          vars: ruleVars,
          env: ruleEnv,
          declaredParamNames: resolved.rule.params,
        },
        resolved.rule.steps,
        io,
      );
    }, resolved.rule.params);
  }

  private mergeStepResult(accOut: string, accErr: string, r: StepResult): StepResult {
    return {
      status: r.status,
      output: accOut + (r.output ?? ""),
      error: accErr + (r.error ?? ""),
      returnValue: r.returnValue,
    };
  }

  private static readonly INLINE_CAPTURE_RE = /\$\{(run|ensure)\s+([^}]+)\}/g;

  /**
   * Interpolate string with inline captures: ${run ref [args]} / ${ensure ref [args]}.
   * Executes each capture, replaces with output, then does regular ${var} interpolation.
   * Returns { ok: true, value } on success or { ok: false, result } on failure.
   */
  private async interpolateWithCaptures(
    input: string,
    scope: Scope,
  ): Promise<{ ok: true; value: string } | { ok: false; result: StepResult }> {
    const re = new RegExp(NodeWorkflowRuntime.INLINE_CAPTURE_RE.source, "g");
    if (!re.test(input)) {
      return { ok: true, value: interpolate(input, scope.vars, scope.env) };
    }
    re.lastIndex = 0;
    let result = "";
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      result += input.slice(lastIndex, m.index);
      const { ref, argsRaw } = parseInlineCaptureCall(m[2]);
      const r = m[1] === "run"
        ? await this.executeRunRef(scope, ref, argsRaw)
        : await this.executeEnsureRef(scope, ref, argsRaw, undefined);
      if (r.status !== 0) return { ok: false, result: r };
      result += r.returnValue ?? r.output.trim();
      lastIndex = m.index + m[0].length;
    }
    result += input.slice(lastIndex);
    return { ok: true, value: interpolate(result, scope.vars, scope.env) };
  }

  private async evaluateMatch(
    scope: Scope,
    expr: MatchExprDef,
  ): Promise<{ ok: true; value: string } | { ok: false; result: StepResult }> {
    // Subject is a bare identifier — resolve against scope variables
    const subject = scope.vars.get(expr.subject) ?? scope.env?.[expr.subject] ?? "";
    for (const arm of expr.arms) {
      let matched = false;
      if (arm.pattern.kind === "wildcard") {
        matched = true;
      } else if (arm.pattern.kind === "string_literal") {
        matched = subject === arm.pattern.value;
      } else if (arm.pattern.kind === "regex") {
        matched = new RegExp(arm.pattern.source).test(subject);
      }
      if (matched) {
        const bodyIr = await this.interpolateWithCaptures(arm.body, scope);
        if (!bodyIr.ok) return bodyIr;
        return { ok: true, value: stripOuterQuotes(bodyIr.value) };
      }
    }
    // Should not reach here if validation ensures a wildcard arm exists.
    return { ok: false, result: { status: 1, output: "", error: "match: no arm matched" } };
  }

  private async executeSteps(scope: Scope, steps: WorkflowStepDef[], io?: StepIO): Promise<StepResult> {
    let accOut = "";
    let accErr = "";
    let returnValue: string | undefined;
    const pendingAsync: Array<{ ref: string; promise: Promise<StepResult> }> = [];
    let asyncCounter = 0;
    for (const step of steps) {
      if (step.type === "comment" || step.type === "blank_line") continue;
      if (step.type === "log") {
        const logIr = await this.interpolateWithCaptures(step.message, scope);
        if (!logIr.ok) return this.mergeStepResult(accOut, accErr, logIr.result);
        const message = logIr.value;
        this.emitLog("LOG", message);
        const chunk = `${message}\n`;
        accOut += chunk;
        io?.appendOut(chunk);
        continue;
      }
      if (step.type === "logerr") {
        const logErrIr = await this.interpolateWithCaptures(step.message, scope);
        if (!logErrIr.ok) return this.mergeStepResult(accOut, accErr, logErrIr.result);
        const message = logErrIr.value;
        this.emitLog("LOGERR", message);
        const chunk = `${message}\n`;
        accErr += chunk;
        io?.appendErr(chunk);
        continue;
      }
      if (step.type === "fail") {
        const failIr = await this.interpolateWithCaptures(step.message, scope);
        if (!failIr.ok) return this.mergeStepResult(accOut, accErr, failIr.result);
        const message = failIr.value;
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
        if (step.managed) {
          if (step.managed.kind === "match") {
            const matchResult = await this.evaluateMatch(scope, step.managed.match);
            if (!matchResult.ok) return this.mergeStepResult(accOut, accErr, matchResult.result);
            returnValue = matchResult.value;
            return this.mergeStepResult(accOut, accErr, { status: 0, output: "", error: "", returnValue });
          }
          const result = step.managed.kind === "run"
            ? await this.executeRunRef(scope, step.managed.ref.value, step.managed.args ?? "")
            : await this.executeEnsureRef(scope, step.managed.ref.value, step.managed.args ?? "", undefined);
          if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
          returnValue = result.returnValue ?? result.output.trim();
          return this.mergeStepResult(accOut, accErr, { status: 0, output: "", error: "", returnValue });
        }
        // Match Bash semantics: return "$var" should return var value, not literal quotes.
        const retIr = await this.interpolateWithCaptures(step.value, scope);
        if (!retIr.ok) return this.mergeStepResult(accOut, accErr, retIr.result);
        returnValue = stripOuterQuotes(retIr.value);
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
          const sendIr = await this.interpolateWithCaptures(step.rhs.token, scope);
          if (!sendIr.ok) return this.mergeStepResult(accOut, accErr, sendIr.result);
          payload = sendIr.value;
        } else if (step.rhs.kind === "var") {
          payload = interpolate(step.rhs.bash, scope.vars, scope.env);
        } else if (step.rhs.kind === "run") {
          const runValue = await this.executeRunRef(scope, step.rhs.ref.value, step.rhs.args ?? "");
          if (runValue.status !== 0) return this.mergeStepResult(accOut, accErr, runValue);
          payload = runValue.returnValue ?? runValue.output.trim();
        } else if (step.rhs.kind === "forward") {
          // Forward sends the first declared parameter value (the message content in inbox dispatch).
          const firstParam = scope.declaredParamNames?.[0];
          payload = (firstParam ? scope.vars.get(firstParam) : undefined) ?? "";
        } else {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: "unsupported send rhs in node runtime",
          });
        }
        this.inboxSeq += 1;
        const seqPadded = String(this.inboxSeq).padStart(3, "0");
        const senderName = ctx.workflowName;
        const msg: InboxMsg = {
          channel: step.channel,
          content: payload,
          sender: senderName,
          seqPadded,
        };
        // Route to the nearest ancestor context that has a route for this channel.
        let targetCtx = ctx;
        for (let i = this.workflowCtxStack.length - 1; i >= 0; i -= 1) {
          if (this.workflowCtxStack[i]!.routes.has(step.channel)) {
            targetCtx = this.workflowCtxStack[i]!;
            break;
          }
        }
        targetCtx.queue.push(msg);
        // Persist inbox file to run directory.
        const inboxFileDir = join(this.runDir, "inbox");
        mkdirSync(inboxFileDir, { recursive: true });
        writeFileSync(join(inboxFileDir, `${seqPadded}-${step.channel}.txt`), payload, "utf8");
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
        const promptIr = await this.interpolateWithCaptures(step.raw, scope);
        if (!promptIr.ok) return this.mergeStepResult(accOut, accErr, promptIr.result);
        let promptText = promptIr.value;
        const promptConfig = resolveConfig(scope.env);
        const backend = promptConfig.backend || "cursor";
        const stepName = resolvePromptStepName(promptConfig);
        const modelRes = resolveModel(promptConfig);
        const promptStep = this.emitPromptStepStart(promptText, stepName, scope.vars, step.raw, scope.declaredParamNames);
        this.emitPromptEvent("PROMPT_START", {
          backend,
          model: modelRes.model || undefined,
          model_reason: modelRes.reason,
          preview: promptText.slice(0, 120),
        });
        let schemaFields: PromptSchemaField[] | undefined;
        if (step.returns !== undefined) {
          schemaFields = parsePromptSchema(step.returns);
          const schemaObject = Object.fromEntries(schemaFields.map((f) => [f.name, f.type]));
          promptText +=
            "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
            JSON.stringify(schemaObject);
        }
        const out = new PassThrough();
        const chunks: string[] = [];
        out.on("data", (d) => {
          const chunk = String(d);
          chunks.push(chunk);
          appendFileSync(promptStep.outFile, chunk);
          io?.appendOut(chunk);
        });
        const result = await executePrompt(promptText, promptConfig, out, scope.env);
        this.emitPromptStepEnd(promptStep, result.status, chunks.join(""), "");
        this.emitPromptEvent("PROMPT_END", { backend, model: modelRes.model || undefined, model_reason: modelRes.reason, status: result.status });
        const output = chunks.join("");
        accOut += output;
        if (result.status !== 0) {
          return this.mergeStepResult(accOut, accErr, {
            status: result.status,
            output: "",
            error: "prompt failed",
          });
        }
        if (schemaFields) {
          if (!step.captureName) {
            return this.mergeStepResult(accOut, accErr, {
              status: 1,
              output: "",
              error: 'prompt with "returns" schema must capture to a variable',
            });
          }
          const extracted = extractJson(result.final);
          if (!extracted) {
            return this.mergeStepResult(accOut, accErr, {
              status: 1,
              output: "",
              error: "prompt returned invalid JSON",
            });
          }
          const validation = validateFields(extracted.obj, schemaFields);
          if (validation !== 0) {
            return this.mergeStepResult(accOut, accErr, {
              status: validation,
              output: "",
              error: "prompt response failed schema validation",
            });
          }
          scope.vars.set(step.captureName, extracted.source);
          for (const field of schemaFields) {
            scope.vars.set(`${step.captureName}_${field.name}`, String(extracted.obj[field.name]));
          }
        } else if (step.captureName) {
          scope.vars.set(step.captureName, result.final);
        }
        continue;
      }
      if (step.type === "const") {
        if (step.value.kind === "expr") {
          const exprIr = await this.interpolateWithCaptures(step.value.bashRhs, scope);
          if (!exprIr.ok) return this.mergeStepResult(accOut, accErr, exprIr.result);
          scope.vars.set(step.name, stripOuterQuotes(exprIr.value));
          continue;
        }
        if (step.value.kind === "run_capture") {
          const runResult = await this.executeRunRef(scope, step.value.ref.value, step.value.args ?? "");
          if (runResult.status !== 0) return this.mergeStepResult(accOut, accErr, runResult);
          scope.vars.set(step.name, runResult.returnValue ?? runResult.output.trim());
          continue;
        }
        if (step.value.kind === "run_inline_script_capture") {
          const shebang = step.value.lang ? `#!/usr/bin/env ${step.value.lang}` : undefined;
          const result = await this.executeInlineScript(scope, step.value.body, shebang, step.value.args ?? "");
          if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
          scope.vars.set(step.name, result.returnValue ?? result.output.trim());
          continue;
        }
        if (step.value.kind === "ensure_capture") {
          const ensureResult = await this.executeEnsureRef(scope, step.value.ref.value, step.value.args ?? "", undefined);
          if (ensureResult.status !== 0) return this.mergeStepResult(accOut, accErr, ensureResult);
          scope.vars.set(step.name, ensureResult.returnValue ?? ensureResult.output.trim());
          continue;
        }
        if (step.value.kind === "match_expr") {
          const matchResult = await this.evaluateMatch(scope, step.value.match);
          if (!matchResult.ok) return this.mergeStepResult(accOut, accErr, matchResult.result);
          scope.vars.set(step.name, matchResult.value);
          continue;
        }
        if (step.value.kind === "prompt_capture") {
          const pcIr = await this.interpolateWithCaptures(step.value.raw, scope);
          if (!pcIr.ok) return this.mergeStepResult(accOut, accErr, pcIr.result);
          let promptText = pcIr.value;
          const promptConfig = resolveConfig(scope.env);
          const backend = promptConfig.backend || "cursor";
          const stepName = resolvePromptStepName(promptConfig);
          const modelRes = resolveModel(promptConfig);
          const promptStep = this.emitPromptStepStart(
            promptText,
            stepName,
            scope.vars,
            step.value.raw,
            scope.declaredParamNames,
          );
          this.emitPromptEvent("PROMPT_START", {
            backend,
            model: modelRes.model || undefined,
            model_reason: modelRes.reason,
            preview: promptText.slice(0, 120),
          });
          let schemaFields: PromptSchemaField[] | undefined;
          if (step.value.returns !== undefined) {
            schemaFields = parsePromptSchema(step.value.returns);
            const schemaObject = Object.fromEntries(schemaFields.map((f) => [f.name, f.type]));
            promptText +=
              "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
              JSON.stringify(schemaObject);
          }
          const out = new PassThrough();
          const chunks: string[] = [];
          out.on("data", (d) => {
            const chunk = String(d);
            chunks.push(chunk);
            appendFileSync(promptStep.outFile, chunk);
            io?.appendOut(chunk);
          });
          const result = await executePrompt(promptText, promptConfig, out, scope.env);
          this.emitPromptStepEnd(promptStep, result.status, chunks.join(""), "");
          this.emitPromptEvent("PROMPT_END", { backend, model: modelRes.model || undefined, model_reason: modelRes.reason, status: result.status });
          const pcOut = chunks.join("");
          accOut += pcOut;
          if (result.status !== 0) {
            return this.mergeStepResult(accOut, accErr, {
              status: result.status,
              output: "",
              error: "prompt failed",
            });
          }
          if (schemaFields) {
            const extracted = extractJson(result.final);
            if (!extracted) {
              return this.mergeStepResult(accOut, accErr, {
                status: 1,
                output: "",
                error: "prompt returned invalid JSON",
              });
            }
            const validation = validateFields(extracted.obj, schemaFields);
            if (validation !== 0) {
              return this.mergeStepResult(accOut, accErr, {
                status: validation,
                output: "",
                error: "prompt response failed schema validation",
              });
            }
            scope.vars.set(step.name, extracted.source);
            for (const field of schemaFields) {
              scope.vars.set(`${step.name}_${field.name}`, String(extracted.obj[field.name]));
            }
          } else {
            scope.vars.set(step.name, result.final);
          }
          continue;
        }
      }
      if (step.type === "run") {
        if (step.async) {
          asyncCounter += 1;
          const branchStack = [...this.getFrameStack()];
          const branchIndices = [...this.getAsyncIndices(), asyncCounter];
          const promise = this.asyncFrameStack.run(branchStack, () =>
            this.asyncIndicesStorage.run(branchIndices, () =>
              this.executeRunRef(scope, step.workflow.value, step.args ?? ""),
            ),
          );
          pendingAsync.push({ ref: step.workflow.value, promise });
          continue;
        }
        const runResult = await this.executeRunRef(scope, step.workflow.value, step.args ?? "");
        if (step.captureName && runResult.status === 0) {
          scope.vars.set(step.captureName, runResult.returnValue ?? runResult.output.trim());
        }
        if (runResult.status !== 0) return this.mergeStepResult(accOut, accErr, runResult);
        continue;
      }
      if (step.type === "run_inline_script") {
        const shebang = step.lang ? `#!/usr/bin/env ${step.lang}` : undefined;
        const result = await this.executeInlineScript(scope, step.body, shebang, step.args ?? "");
        if (step.captureName && result.status === 0) {
          scope.vars.set(step.captureName, result.returnValue ?? result.output.trim());
        }
        if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
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
      if (step.type === "match") {
        const matchResult = await this.evaluateMatch(scope, step.expr);
        if (!matchResult.ok) return this.mergeStepResult(accOut, accErr, matchResult.result);
        // Standalone match: value is discarded
        continue;
      }
    }
    // Implicit join: await all pending async steps before returning.
    if (pendingAsync.length > 0) {
      const settled = await Promise.allSettled(pendingAsync.map((p) => p.promise));
      const failures: string[] = [];
      for (let i = 0; i < settled.length; i += 1) {
        const r = settled[i]!;
        if (r.status === "rejected") {
          failures.push(`run async ${pendingAsync[i]!.ref}: ${String(r.reason)}`);
        } else if (r.value.status !== 0) {
          failures.push(`run async ${pendingAsync[i]!.ref}: ${r.value.error}`);
          accOut += r.value.output;
          accErr += r.value.error;
        } else {
          accOut += r.value.output;
        }
      }
      if (failures.length > 0) {
        const aggregated = failures.length === 1
          ? failures[0]!
          : `${failures.length} async steps failed:\n${failures.join("\n")}`;
        return { status: 1, output: accOut, error: accErr + aggregated };
      }
    }
    return { status: 0, output: accOut, error: accErr, returnValue };
  }

  /** Build dispatch scope that binds message/channel/sender to the target workflow's declared param names. */
  private buildInboxDispatchScope(scope: Scope, target: string, msg: InboxMsg): Scope {
    const dispatchVars = new Map(scope.vars);
    const resolved = resolveWorkflowRef(this.graph, scope.filePath, { value: target, loc: { line: 1, col: 1 } });
    const params = resolved?.workflow.params ?? [];
    const values = [msg.content, msg.channel, msg.sender];
    params.forEach((name, i) => {
      if (i < values.length) dispatchVars.set(name, values[i]);
    });
    return { filePath: scope.filePath, vars: dispatchVars, env: scope.env };
  }

  private async drainWorkflowQueue(scope: Scope, ctx: WorkflowContext): Promise<StepResult> {
    const parallel = scope.env.JAIPH_INBOX_PARALLEL === "true";
    let cursor = 0;
    while (cursor < ctx.queue.length) {
      const msg = ctx.queue[cursor]!;
      cursor += 1;
      const targets = ctx.routes.get(msg.channel) ?? [];
      if (targets.length === 0) continue;
      if (parallel) {
        const dispatches = await Promise.all(
          targets.map(async (target) => {
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
            const t0 = Date.now();
            const result = await this.executeRunRef(
              this.buildInboxDispatchScope(scope, target, msg),
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
                status: result.status,
                elapsed_ms: Date.now() - t0,
                event_version: 1,
              }),
            );
            return result;
          }),
        );
        for (const d of dispatches) {
          if (d.status !== 0) return d;
        }
      } else {
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
          const t0 = Date.now();
          const dispatch = await this.executeRunRef(
            this.buildInboxDispatchScope(scope, target, msg),
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
              elapsed_ms: Date.now() - t0,
              event_version: 1,
            }),
          );
          if (dispatch.status !== 0) return dispatch;
        }
      }
    }
    return { status: 0, output: "", error: "" };
  }

  private mockKey(filePath: string, name: string): string {
    return `${filePath}::${name}`;
  }

  private async executeRunRef(scope: Scope, ref: string, argsRaw: string): Promise<StepResult> {
    const args = parseArgsRaw(argsRaw, scope.vars, scope.env);
    const resolvedWorkflow = resolveWorkflowRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
    if (resolvedWorkflow) {
      const mk = this.mockKey(resolvedWorkflow.filePath, resolvedWorkflow.workflow.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep(
          "workflow",
          ref,
          args,
          async () => this.executeMockBodyDef(ref, mockBody, args),
          resolvedWorkflow.workflow.params,
        );
      }
      return this.executeWorkflow(resolvedWorkflow.filePath, resolvedWorkflow.workflow.name, scope, args, true);
    }
    const resolvedScript = resolveScriptRef(this.graph, scope.filePath, ref);
    if (resolvedScript) {
      const mk = this.mockKey(resolvedScript.filePath, resolvedScript.script.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep("script", ref, args, async () => this.executeMockBodyDef(ref, mockBody, args));
      }
      return this.executeManagedStep(
        "script",
        ref,
        args,
        async (io) => this.executeScript(resolvedScript.filePath, resolvedScript.script.name, args, scope.env, io),
      );
    }
    return { status: 1, output: "", error: `Unknown run target: ${ref}` };
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
      const mk = this.mockKey(resolvedRule.filePath, resolvedRule.rule.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep(
          "rule",
          ref,
          args,
          async () => this.executeMockBodyDef(ref, mockBody, args),
          resolvedRule.rule.params,
        );
      }
      return this.executeRule(resolvedRule.filePath, resolvedRule.rule.name, scope, args);
    };
    if (!recover) return attempt();
    const maxRetries = Number(this.env.JAIPH_ENSURE_MAX_RETRIES ?? "3");
    for (let i = 0; i < maxRetries; i += 1) {
      const res = await attempt();
      if (res.status === 0) return res;
      const recoverSteps = "single" in recover ? [recover.single] : recover.block;
      // Recover blocks receive the failed ensure output under the explicit binding name.
      const recoverVars = new Map(scope.vars);
      const recoverPayload = `${res.output}${res.error}`;
      recoverVars.set(recover.bindings.failure, recoverPayload);
      if (recover.bindings.attempt) {
        recoverVars.set(recover.bindings.attempt, String(i + 1));
      }
      const recoverScope: Scope = {
        ...scope,
        vars: recoverVars,
      };
      const rr = await this.executeSteps(recoverScope, recoverSteps);
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
    const scriptCwd =
      env.JAIPH_WORKSPACE && env.JAIPH_WORKSPACE.length > 0 ? env.JAIPH_WORKSPACE : dirname(filePath);
    return await new Promise((resolve) => {
      const child = spawn(scriptPath, args, {
        cwd: scriptCwd,
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

  private async executeInlineScript(
    scope: Scope,
    body: string,
    shebang: string | undefined,
    argsRaw: string,
  ): Promise<StepResult> {
    const args = parseArgsRaw(argsRaw, scope.vars, scope.env);
    const scriptName = inlineScriptName(body, shebang);
    return this.executeManagedStep(
      "script",
      scriptName,
      args,
      async (io) => this.executeScript(scope.filePath, scriptName, args, scope.env, io),
    );
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
    declaredParamNames?: string[],
  ): Promise<StepResult> {
    this.stepSeq += 1;
    const seq = this.stepSeq;
    const safe = sanitizeName(`${kind}__${name}`);
    const outFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.out`);
    const errFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.err`);
    const stack = this.getFrameStack();
    const parentId = stack.length > 0 ? stack[stack.length - 1]!.id : null;
    const id = `${this.runId}:${process.pid}:${seq}`;
    const depth = stack.length;
    const frame: Frame = { id, kind, name };
    stack.push(frame);
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
      params: buildStepDisplayParamPairs(args, declaredParamNames, { positionalStyle: "argN" }),
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
      params: buildStepDisplayParamPairs(args, declaredParamNames, { positionalStyle: "argN" }),
      out_content: (result.output ?? "").slice(0, MAX_EMBED),
      err_content: result.status !== 0 ? (result.error ?? "").slice(0, MAX_EMBED) : "",
    });
    stack.pop();
    return result;
  }

  private emitStep(payload: Record<string, unknown>): void {
    const indices = this.getAsyncIndices();
    const full = indices.length > 0 ? { ...payload, async_indices: indices } : payload;
    if (this.env.JAIPH_TEST_MODE !== "1") {
      process.stderr.write(`__JAIPH_EVENT__ ${JSON.stringify(full)}\n`);
    }
    appendRunSummaryLine(JSON.stringify({ ...full, event_version: 1 }));
  }

  private async executeMockBodyDef(ref: string, mockDef: MockBodyDef, args: string[]): Promise<StepResult> {
    if (mockDef.kind === "shell") {
      return this.executeMockShellBody(ref, mockDef.body, args, mockDef.params);
    }
    // Jaiph step-based mock (workflow/rule)
    const scope: Scope = {
      filePath: this.graph.entryFile,
      vars: new Map<string, string>(),
      env: { ...this.env },
      declaredParamNames: mockDef.params,
    };
    mockDef.params.forEach((name, i) => {
      if (i < args.length) scope.vars.set(name, args[i]);
    });
    return this.executeSteps(scope, mockDef.steps);
  }

  private executeMockShellBody(_ref: string, body: string, args: string[], params: string[]): StepResult {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const { mkdtempSync, writeFileSync: wf, chmodSync } = require("node:fs") as typeof import("node:fs");
    const { join: pjoin } = require("node:path") as typeof import("node:path");
    const tmpDir = mkdtempSync(pjoin(require("node:os").tmpdir(), "jaiph-mock-"));
    const scriptPath = pjoin(tmpDir, "mock.sh");
    wf(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(scriptPath, 0o755);
    // Inject named params as env vars
    const env = { ...this.env };
    params.forEach((name, i) => {
      if (i < args.length) env[name] = args[i];
    });
    const r = spawnSync(scriptPath, args, {
      encoding: "utf8",
      cwd: this.cwd,
      env,
    });
    try { require("node:fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return {
      status: r.status ?? 1,
      output: r.stdout ?? "",
      error: r.stderr ?? "",
      returnValue: (r.stdout ?? "").trim(),
    };
  }
}
