import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inlineScriptName } from "../../inline-script-name";
import { argsToRuntimeString } from "../../parse/core";
import type { CatchBody, Expr, MatchExprDef, WorkflowStepDef } from "../../types";
import { executePrompt, resolveConfig, resolveModel, resolvePromptStepName } from "./prompt";
import { appendRunSummaryLine } from "./emit";
import { buildStepDisplayParamPairs } from "../../cli/commands/format-params.js";
import { resolveRuleRef, resolveScriptRef, resolveWorkflowRef, type RuntimeGraph } from "./graph";
import type { WorkflowMetadata } from "../../types";
import { interpolateWorkflowMetadata } from "../../config";
import { extractJson, validateFields } from "./schema";
import { canonicalizeTripleQuotedString } from "../../parse/triple-quote";
import {
  commaArgsToInterpolated,
  interpolate,
  MAX_EMBED,
  MAX_RECURSION_DEPTH,
  nowIso,
  parseArgTokens,
  parseInlineCaptureCall,
  parsePromptSchema,
  sanitizeName,
  stripOuterQuotes,
  type PromptSchemaField,
} from "./runtime-arg-parser";
import { resolveInterpreterFromShebang } from "../../parse/script-bash";
import { resolveShell } from "./portability";
import { RuntimeEventEmitter, type Frame } from "./runtime-event-emitter";
import { executeMockBodyDef, type MockBodyDef, type StepResult } from "./runtime-mock";
import { linesOfDelimitedString } from "../string-lines";
import {
  defaultPromptSleep,
  formatRetryDelay,
  isPromptRetryAbortError,
  resolvePromptRetryDelays,
  summarizeError,
} from "./prompt-retry";

export type { MockBodyDef } from "./runtime-mock";

const HANDLE_PREFIX = "__JAIPH_HANDLE__";

/**
 * Test seam for the script/shell subprocess spawn. Swapped out in unit tests so
 * the resolved interpreter + argv can be asserted on the spawn call itself
 * without side effects (mirrors `_portability.spawn` in `portability.ts`).
 */
export const _scriptSpawn = { spawn };

export function formatInvalidAsyncHandleError(handleId: string): string {
  return `invalid async handle "${handleId}" — the handle was never created or was already consumed`;
}

const DEFAULT_INBOX_DISPATCH_LIMIT = 1000;

function resolveInboxDispatchLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_INBOX_MAX_DISPATCH;
  if (raw === undefined || raw === "") return DEFAULT_INBOX_DISPATCH_LIMIT;
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_INBOX_DISPATCH_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INBOX_DISPATCH_LIMIT;
  return n;
}

type AsyncHandle = {
  ref: string;
  promise: Promise<StepResult>;
  resolved?: StepResult;
};

type Scope = {
  filePath: string;
  vars: Map<string, string>;
  env: NodeJS.ProcessEnv;
  /** Declared parameter names for the active workflow or rule. */
  declaredParamNames?: string[];
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
  workflowMeta?: WorkflowMetadata;
};

export class NodeWorkflowRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly graph: RuntimeGraph;
  private readonly runId: string;
  private readonly runDir: string;
  private readonly summaryFile: string;
  private readonly emitter: RuntimeEventEmitter;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private stack: Frame[] = [];
  private asyncFrameStack = new AsyncLocalStorage<Frame[]>();
  private asyncIndicesStorage = new AsyncLocalStorage<number[]>();
  private inboxSeq = 0;
  private workflowCtxStack: WorkflowContext[] = [];
  private readonly mockBodies: Map<string, MockBodyDef>;
  private handleRegistry = new Map<string, AsyncHandle>();
  private handleIdCounter = 0;
  private readonly abortController = new AbortController();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Retry schedule for transport-failure backoff in `runPromptStep`. Resolved
   * lazily from constructor opt or env on first prompt; cached thereafter so
   * the same workflow run uses a single (validated) schedule and a parse
   * failure does not get re-thrown per attempt.
   */
  private cachedPromptRetryDelays: number[] | undefined;
  private cachedPromptRetryError: Error | undefined;
  private readonly promptRetryDelaysOverride: readonly number[] | undefined;

  private getFrameStack(): Frame[] {
    return this.asyncFrameStack.getStore() ?? this.stack;
  }

  private getAsyncIndices(): number[] {
    return this.asyncIndicesStorage.getStore() ?? [];
  }

  private createHandle(ref: string, promise: Promise<StepResult>): string {
    this.handleIdCounter += 1;
    const handleId = `${HANDLE_PREFIX}${this.handleIdCounter}`;
    this.handleRegistry.set(handleId, { ref, promise });
    return handleId;
  }

  private isHandle(value: string): boolean {
    return value.startsWith(HANDLE_PREFIX);
  }

  /** Resolve a handle to its StepResult. Caches the result for subsequent reads. */
  private async resolveHandleResult(handleId: string): Promise<StepResult> {
    const handle = this.handleRegistry.get(handleId);
    if (!handle) {
      return { status: 1, output: "", error: formatInvalidAsyncHandleError(handleId) };
    }
    if (handle.resolved) return handle.resolved;
    const result = await handle.promise;
    handle.resolved = result;
    return result;
  }

  /** Resolve a handle value to the string it represents. Updates scope var in place. */
  private async resolveHandleVar(scope: Scope, varName: string): Promise<StepResult> {
    const val = scope.vars.get(varName);
    if (!val || !this.isHandle(val)) return { status: 0, output: "", error: "" };
    const result = await this.resolveHandleResult(val);
    if (result.status === 0) {
      scope.vars.set(varName, result.returnValue ?? result.output.trim());
    } else {
      scope.vars.set(varName, "");
    }
    return result;
  }

  /**
   * Resolve an `if` / `match` subject to its value. Accepts plain identifiers
   * (`status`) and `IDENT.IDENT` dot subjects (`r.verdict`) — the latter
   * parses JSON from the base variable and extracts the field, mirroring
   * `${var.field}` interpolation semantics.
   */
  private async resolveSubjectValue(
    scope: Scope,
    subject: string,
  ): Promise<{ ok: true; value: string } | { ok: false; result: StepResult }> {
    const dotIdx = subject.indexOf(".");
    const base = dotIdx === -1 ? subject : subject.slice(0, dotIdx);
    const rawBase = scope.vars.get(base);
    if (rawBase && this.isHandle(rawBase)) {
      const hr = await this.resolveHandleVar(scope, base);
      if (hr.status !== 0) return { ok: false, result: hr };
    }
    const baseVal = scope.vars.get(base) ?? scope.env?.[base] ?? "";
    if (dotIdx === -1) return { ok: true, value: baseVal };
    const field = subject.slice(dotIdx + 1);
    try {
      const obj = JSON.parse(baseVal);
      if (obj != null && typeof obj === "object" && field in obj) {
        return { ok: true, value: String((obj as Record<string, unknown>)[field]) };
      }
    } catch {
      // fall through to empty
    }
    return { ok: true, value: "" };
  }

  /** Scan input for ${var} references and resolve any that are handles. */
  private async resolveHandlesInInput(scope: Scope, input: string): Promise<StepResult | null> {
    const re = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const varName = m[1];
      const val = scope.vars.get(varName);
      if (val && this.isHandle(val)) {
        const r = await this.resolveHandleVar(scope, varName);
        if (r.status !== 0) return r;
      }
    }
    return null;
  }

  constructor(
    graph: RuntimeGraph,
    opts: {
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      mockBodies?: Map<string, MockBodyDef>;
      /**
       * When true, the runtime's event emitter skips writing `__JAIPH_EVENT__`
       * lines to stderr (durable `run_summary.jsonl` writes are unaffected).
       * Used by in-process callers like the test runner that share stderr
       * with `node --test` reporter output.
       */
      suppressLiveEvents?: boolean;
      /**
       * Injectable backoff sleep. Tests pass a stub to record requested delays
       * and resolve immediately; production uses `defaultPromptSleep` which
       * races setTimeout against the runtime's AbortSignal.
       */
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      /**
       * Override the prompt-retry delay schedule. When set, takes precedence
       * over `JAIPH_PROMPT_RETRY` / `JAIPH_PROMPT_RETRY_DELAYS`. Empty array
       * disables retries (1 attempt total). Used by tests to assert the full
       * sequence with zero real wall-clock wait.
       */
      promptRetryDelays?: readonly number[];
    },
  ) {
    this.graph = graph;
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? process.cwd();
    this.mockBodies = opts.mockBodies ?? new Map();
    this.sleep = opts.sleep ?? defaultPromptSleep;
    this.promptRetryDelaysOverride = opts.promptRetryDelays;
    this.runId = this.env.JAIPH_RUN_ID || randomUUID();
    const source = this.env.JAIPH_SOURCE_FILE ?? basename(graph.entryFile);
    const date = new Date();
    const datePart = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const timePart = `${String(date.getUTCHours()).padStart(2, "0")}-${String(date.getUTCMinutes()).padStart(2, "0")}-${String(date.getUTCSeconds()).padStart(2, "0")}`;
    const runsRoot = this.resolveRunsRoot();
    this.runDir = join(runsRoot, datePart, `${timePart}-${source}`);
    mkdirSync(this.runDir, { recursive: true });
    const artifactsDir = join(this.runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    this.summaryFile = join(this.runDir, "run_summary.jsonl");
    writeFileSync(this.summaryFile, "");
    this.env.JAIPH_RUN_SUMMARY_FILE = this.summaryFile;
    this.env.JAIPH_RUN_ID = this.runId;
    this.env.JAIPH_RUN_DIR = this.runDir;
    this.env.JAIPH_ARTIFACTS_DIR = artifactsDir;
    this.emitter = new RuntimeEventEmitter({
      runId: this.runId,
      runDir: this.runDir,
      env: this.env,
      getFrameStack: () => this.getFrameStack(),
      getAsyncIndices: () => this.getAsyncIndices(),
      suppressLiveEvents: opts.suppressLiveEvents,
    });
    this.startHeartbeat();
  }

  /**
   * Signal cooperative cancellation. Aborts any in-flight prompt-retry sleep
   * so the retry loop exits without further `executePrompt` calls. Exposed
   * for in-process hosts and tests; the runner process itself terminates on
   * SIGINT/SIGTERM by Node default, which is sufficient for the CLI path.
   */
  abort(): void {
    this.abortController.abort();
  }

  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Resolve and cache the prompt-retry delay schedule (constructor override
   * wins over env). On invalid env parse the error is cached and re-returned
   * so every prompt in the same run surfaces the same misconfiguration.
   */
  private getPromptRetryDelays(): { ok: true; delays: number[] } | { ok: false; error: string } {
    if (this.cachedPromptRetryError) {
      return { ok: false, error: this.cachedPromptRetryError.message };
    }
    if (this.cachedPromptRetryDelays !== undefined) {
      return { ok: true, delays: this.cachedPromptRetryDelays };
    }
    if (this.promptRetryDelaysOverride !== undefined) {
      this.cachedPromptRetryDelays = [...this.promptRetryDelaysOverride];
      return { ok: true, delays: this.cachedPromptRetryDelays };
    }
    try {
      this.cachedPromptRetryDelays = resolvePromptRetryDelays(this.env);
      return { ok: true, delays: this.cachedPromptRetryDelays };
    } catch (err) {
      this.cachedPromptRetryError = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error: this.cachedPromptRetryError.message };
    }
  }

  getRunDir(): string {
    return this.runDir;
  }

  getSummaryFile(): string {
    return this.summaryFile;
  }

  private writeHeartbeat(): void {
    try {
      writeFileSync(join(this.runDir, "heartbeat"), String(Date.now()), "utf8");
    } catch {
      // best-effort; don't crash the runtime
    }
  }

  private startHeartbeat(): void {
    this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), 10_000);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  async runDefault(args: string[]): Promise<number> {
    return this.runRoot("default", args);
  }

  /**
   * Run a workflow from the entry module as the root of a run (same contract
   * as `runDefault`, with the entry symbol parameterized): emits
   * WORKFLOW_START/END and persists `return_value.txt`. Used by `jaiph run`
   * (`default`) and by `jaiph mcp` tool calls (any exposed workflow).
   */
  async runRoot(workflowName: string, args: string[]): Promise<number> {
    this.emitter.emitWorkflow("WORKFLOW_START", workflowName);
    const rootScope: Scope = {
      filePath: this.graph.entryFile,
      vars: this.newScopeVars(this.graph.entryFile, undefined, this.env),
      env: { ...this.env },
    };
    const resolved = resolveWorkflowRef(this.graph, this.graph.entryFile, {
      value: workflowName,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      process.stderr.write(
        workflowName === "default"
          ? "jaiph run requires workflow 'default' in the input file\n"
          : `jaiph run: unknown workflow '${workflowName}' in the input file\n`,
      );
      this.emitter.emitWorkflow("WORKFLOW_END", workflowName);
      this.stopHeartbeat();
      return 1;
    }
    // Bind CLI args to declared parameter names by position.
    resolved.workflow.params.forEach((name, i) => {
      if (i < args.length) rootScope.vars.set(name, args[i]);
    });
    const result = await this.executeWorkflow(resolved.filePath, resolved.workflow.name, rootScope, args, false);
    // Persist the workflow's return value so the CLI can print it after the run tree.
    // Empty/undefined values are written as an empty file so the consumer can distinguish
    // "ran with no return" from "no run happened".
    if (result.status === 0 && result.returnValue !== undefined) {
      try {
        writeFileSync(join(this.runDir, "return_value.txt"), result.returnValue, "utf8");
      } catch {
        // Best-effort capture; the run succeeded regardless.
      }
    }
    this.emitter.emitWorkflow("WORKFLOW_END", workflowName);
    this.stopHeartbeat();
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
      this.stopHeartbeat();
      return { status: 1, output: `Unknown workflow: ${ref}` };
    }
    // Bind args to declared parameter names by position.
    resolved.workflow.params.forEach((name, i) => {
      if (i < args.length) rootScope.vars.set(name, args[i]);
    });
    const result = await this.executeWorkflow(resolved.filePath, resolved.workflow.name, rootScope, args, false);
    this.stopHeartbeat();
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
      const metadataVars = this.newScopeVars(resolved.filePath, scope.vars, scope.env);
      resolved.workflow.params.forEach((name, i) => {
        if (i < args.length) metadataVars.set(name, args[i]);
      });
      // Root entry (`runDefault`, inheritCallerMetadataScope=false): apply entry module + workflow metadata.
      // Nested cross-module `run`: layer callee module + workflow metadata on top of the caller's
      // effective env (same mechanics as root entry, respecting `${NAME}_LOCKED`).  A module's
      // config describes how that module's workflows run, regardless of who called them; this
      // also matches cross-module `ensure` (see `executeRule`).
      // Same-module nested `run`: apply only the callee workflow-level metadata (workflow boundaries
      // still apply within one module; module config is already in the caller's effective env).
      let workflowEnv: NodeJS.ProcessEnv;
      if (inheritCallerMetadataScope && crossModuleNested) {
        workflowEnv = this.applyMetadataScope(
          scope.env,
          this.graph.modules.get(resolved.filePath)?.ast.metadata,
          resolved.workflow.metadata,
          metadataVars,
        );
      } else if (inheritCallerMetadataScope) {
        workflowEnv = this.applyMetadataScope(scope.env, undefined, resolved.workflow.metadata, metadataVars);
      } else {
        workflowEnv = this.applyMetadataScope(
          scope.env,
          this.graph.modules.get(resolved.filePath)?.ast.metadata,
          resolved.workflow.metadata,
          metadataVars,
        );
      }
      const childScope: Scope = {
        filePath: resolved.filePath,
        vars: metadataVars,
        env: workflowEnv,
        declaredParamNames: resolved.workflow.params,
      };
      const ctx: WorkflowContext = {
        workflowName,
        routes: new Map(),
        queue: [],
        workflowMeta: resolved.workflow.metadata,
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
      const metadataVars = this.newScopeVars(resolved.filePath, scope.vars, scope.env);
      const ruleEnv = this.applyMetadataScope(scope.env, moduleMeta, undefined, metadataVars);
      const ruleVars = new Map(metadataVars);
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
    // Resolve any handle-valued vars referenced in the input before interpolating.
    const handleErr = await this.resolveHandlesInInput(scope, input);
    if (handleErr) return { ok: false, result: handleErr };
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
    const resolved = await this.resolveSubjectValue(scope, expr.subject);
    if (!resolved.ok) return { ok: false, result: resolved.result };
    const subject = resolved.value;
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
        let body = arm.body.trimStart();
        if (arm.tripleQuotedBody) {
          body = canonicalizeTripleQuotedString(arm.body).trimStart();
        }

        // fail "message" — abort with failure
        if (body.startsWith("fail ")) {
          const msgRaw = body.slice(5).trimStart();
          const msgIr = await this.interpolateWithCaptures(msgRaw, scope);
          if (!msgIr.ok) return msgIr;
          return { ok: false, result: { status: 1, output: "", error: stripOuterQuotes(msgIr.value) } };
        }

        // run ref(args) — execute script/workflow and capture return value
        const runM = body.match(/^run\s+([A-Za-z_][A-Za-z0-9_.]*)\(([^)]*)\)\s*$/);
        if (runM) {
          const result = await this.executeRunRef(scope, runM[1]!, commaArgsToInterpolated(runM[2]!));
          if (result.status !== 0) return { ok: false, result };
          return { ok: true, value: result.returnValue ?? result.output.trim() };
        }

        // ensure ref(args) — execute rule and capture return value
        const ensureM = body.match(/^ensure\s+([A-Za-z_][A-Za-z0-9_.]*)\(([^)]*)\)\s*$/);
        if (ensureM) {
          const result = await this.executeEnsureRef(scope, ensureM[1]!, commaArgsToInterpolated(ensureM[2]!), undefined);
          if (result.status !== 0) return { ok: false, result };
          return { ok: true, value: result.returnValue ?? result.output.trim() };
        }

        // Bare in-scope identifier (e.g. `=> name_arg`) — sugar for `=> "${name_arg}"`.
        // Validator already ensures the identifier is in scope; runtime mirrors `return val`.
        const bareIdent = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (bareIdent && (scope.vars.has(bareIdent[1]!) || scope.env?.[bareIdent[1]!] !== undefined)) {
          return { ok: true, value: scope.vars.get(bareIdent[1]!) ?? scope.env?.[bareIdent[1]!] ?? "" };
        }

        // Default: string expression
        const bodyIr = await this.interpolateWithCaptures(body, scope);
        if (!bodyIr.ok) return bodyIr;
        return { ok: true, value: stripOuterQuotes(bodyIr.value) };
      }
    }
    // Should not reach here if validation ensures a wildcard arm exists.
    return { ok: false, result: { status: 1, output: "", error: "match: no arm matched" } };
  }

  /**
   * Evaluate an `Expr` to its string value, executing any managed call
   * (call/ensure_call/inline_script/match/prompt) and returning its captured
   * result. Used by `const` / `return` / `send` / `say` step handlers so they
   * don't each duplicate the dispatch table.
   *
   * `promptCaptureName` lets callers route prompt-side effects (e.g. schema
   * field exports) into a scope binding; pass `undefined` for non-capture
   * positions.
   */
  private async evaluateExpr(
    scope: Scope,
    expr: Expr,
    promptCaptureName: string | undefined,
    io: StepIO | undefined,
  ): Promise<{ ok: true; value: string; output: string } | { ok: false; result: StepResult; output: string }> {
    if (expr.kind === "literal") {
      const ir = await this.interpolateWithCaptures(expr.raw, scope);
      if (!ir.ok) return { ok: false, result: ir.result, output: "" };
      return { ok: true, value: ir.value, output: "" };
    }
    if (expr.kind === "call") {
      const r = await this.executeRunRef(scope, expr.callee.value, argsToRuntimeString(expr.args));
      if (r.status !== 0) return { ok: false, result: r, output: "" };
      return { ok: true, value: r.returnValue ?? r.output.trim(), output: "" };
    }
    if (expr.kind === "ensure_call") {
      const r = await this.executeEnsureRef(scope, expr.callee.value, argsToRuntimeString(expr.args), undefined);
      if (r.status !== 0) return { ok: false, result: r, output: "" };
      return { ok: true, value: r.returnValue ?? r.output.trim(), output: "" };
    }
    if (expr.kind === "inline_script") {
      const shebang = expr.lang ? `#!/usr/bin/env ${expr.lang}` : undefined;
      const r = await this.executeInlineScript(scope, expr.body, shebang, argsToRuntimeString(expr.args));
      if (r.status !== 0) return { ok: false, result: r, output: "" };
      return { ok: true, value: r.returnValue ?? r.output.trim(), output: "" };
    }
    if (expr.kind === "match") {
      const mr = await this.evaluateMatch(scope, expr.match);
      if (!mr.ok) return { ok: false, result: mr.result, output: "" };
      return { ok: true, value: mr.value, output: "" };
    }
    if (expr.kind === "prompt") {
      if (expr.returns !== undefined && !promptCaptureName) {
        return {
          ok: false,
          result: { status: 1, output: "", error: 'prompt with "returns" schema must capture to a variable' },
          output: "",
        };
      }
      const r = await this.runPromptStep(scope, expr.raw, expr.returns, promptCaptureName, io);
      if (!r.ok) return { ok: false, result: r.result, output: r.output };
      // For captured prompts `runPromptStep` writes the value into scope and we
      // return that here; non-capture prompts (no binding) yield empty string.
      const value = promptCaptureName ? (scope.vars.get(promptCaptureName) ?? "") : "";
      return { ok: true, value, output: r.output };
    }
    // shell / bare_ref should never reach the runtime — validator rejects them
    // outside their narrow send-RHS lane (and shell-as-send is rejected too).
    return {
      ok: false,
      result: { status: 1, output: "", error: `unsupported expression kind in runtime: ${expr.kind}` },
      output: "",
    };
  }

  private async executeSteps(scope: Scope, steps: WorkflowStepDef[], io?: StepIO): Promise<StepResult> {
    let accOut = "";
    let accErr = "";
    let returnValue: string | undefined;
    /** Handle IDs created by `run async` in this scope (for implicit join at exit). */
    const localHandleIds: string[] = [];
    let asyncCounter = 0;
    for (const step of steps) {
      if (step.type === "trivia") continue;
      if (step.type === "say") {
        let message: string;
        if (step.message.kind === "inline_script") {
          const shebang = step.message.lang ? `#!/usr/bin/env ${step.message.lang}` : undefined;
          const result = await this.executeInlineScript(scope, step.message.body, shebang, argsToRuntimeString(step.message.args));
          if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
          message = result.returnValue ?? result.output.trim();
        } else if (step.message.kind === "literal") {
          const ir = await this.interpolateWithCaptures(step.message.raw, scope);
          if (!ir.ok) return this.mergeStepResult(accOut, accErr, ir.result);
          message = step.level === "fail" || step.level === "logerr"
            ? stripOuterQuotes(ir.value)
            : ir.value;
        } else {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: `unsupported ${step.level} message kind: ${step.message.kind}`,
          });
        }
        if (step.level === "fail") {
          return this.mergeStepResult(accOut, accErr, { status: 1, output: "", error: message });
        }
        const eventLevel = step.level === "log" ? "LOG" : "LOGERR";
        this.emitter.emitLog(eventLevel, message);
        const chunk = `${message}\n`;
        if (step.level === "log") {
          accOut += chunk;
          io?.appendOut(chunk);
        } else {
          accErr += chunk;
          io?.appendErr(chunk);
        }
        continue;
      }
      if (step.type === "return") {
        const value = step.value;
        if (value.kind === "literal") {
          const retIr = await this.interpolateWithCaptures(value.raw, scope);
          if (!retIr.ok) return this.mergeStepResult(accOut, accErr, retIr.result);
          returnValue = stripOuterQuotes(retIr.value);
          return this.mergeStepResult(accOut, accErr, { status: 0, output: "", error: "", returnValue });
        }
        const r = await this.evaluateExpr(scope, value, undefined, io);
        accOut += r.output;
        if (!r.ok) return this.mergeStepResult(accOut, accErr, r.result);
        returnValue = r.value;
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
        const sendValue = step.value;
        if (sendValue.kind === "literal") {
          const sendIr = await this.interpolateWithCaptures(sendValue.raw, scope);
          if (!sendIr.ok) return this.mergeStepResult(accOut, accErr, sendIr.result);
          payload = stripOuterQuotes(sendIr.value);
        } else if (sendValue.kind === "call") {
          const r = await this.executeRunRef(scope, sendValue.callee.value, argsToRuntimeString(sendValue.args));
          if (r.status !== 0) return this.mergeStepResult(accOut, accErr, r);
          payload = r.returnValue ?? r.output.trim();
        } else {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: `unsupported send value kind: ${sendValue.kind}`,
          });
        }
        this.inboxSeq += 1;
        const seqPadded = String(this.inboxSeq).padStart(3, "0");
        const senderName = ctx.workflowName;
        // Validator (validateChannelRef) has already proven that an `alias.name`
        // token refers to an existing imported channel. Routes are registered
        // under the bare channel name, so strip the alias prefix so the same
        // key resolves regardless of how the send was spelled.
        const dotIdx = step.channel.indexOf(".");
        const channelKey = dotIdx >= 0 ? step.channel.slice(dotIdx + 1) : step.channel;
        const msg: InboxMsg = {
          channel: channelKey,
          content: payload,
          sender: senderName,
          seqPadded,
        };
        let targetCtx = ctx;
        let routed = false;
        for (let i = this.workflowCtxStack.length - 1; i >= 0; i -= 1) {
          if (this.workflowCtxStack[i]!.routes.has(channelKey)) {
            targetCtx = this.workflowCtxStack[i]!;
            routed = true;
            break;
          }
        }
        targetCtx.queue.push(msg);
        if (routed) {
          const inboxFileDir = join(this.runDir, "inbox");
          mkdirSync(inboxFileDir, { recursive: true });
          writeFileSync(join(inboxFileDir, `${seqPadded}-${channelKey}.txt`), payload, "utf8");
        }
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
      if (step.type === "const") {
        const v = step.value;
        if (v.kind === "literal") {
          const exprIr = await this.interpolateWithCaptures(v.raw, scope);
          if (!exprIr.ok) return this.mergeStepResult(accOut, accErr, exprIr.result);
          scope.vars.set(step.name, stripOuterQuotes(exprIr.value));
          continue;
        }
        if (v.kind === "call" && v.async) {
          asyncCounter += 1;
          const captureRef = v.callee.value;
          const captureArgs = argsToRuntimeString(v.args);
          const branchStack = [...this.getFrameStack()];
          const branchIndices = [...this.getAsyncIndices(), asyncCounter];
          const promise = this.asyncFrameStack.run(branchStack, () =>
            this.asyncIndicesStorage.run(branchIndices, () =>
              this.executeRunRef(scope, captureRef, captureArgs),
            ),
          );
          const handleId = this.createHandle(captureRef, promise);
          localHandleIds.push(handleId);
          scope.vars.set(step.name, handleId);
          continue;
        }
        const r = await this.evaluateExpr(scope, v, step.name, io);
        accOut += r.output;
        if (!r.ok) return this.mergeStepResult(accOut, accErr, r.result);
        // Prompt handlers bind via captureName side effect inside runPromptStep;
        // all other Expr kinds bind here.
        if (v.kind !== "prompt") {
          scope.vars.set(step.name, r.value);
        }
        continue;
      }
      if (step.type === "exec") {
        const body = step.body;
        if (body.kind === "call" && body.async) {
          asyncCounter += 1;
          const branchStack = [...this.getFrameStack()];
          const branchIndices = [...this.getAsyncIndices(), asyncCounter];
          const ref = body.callee.value;
          const argsRaw = argsToRuntimeString(body.args);
          const runInBranch = (fn: () => Promise<StepResult>): Promise<StepResult> =>
            this.asyncFrameStack.run(branchStack, () =>
              this.asyncIndicesStorage.run(branchIndices, fn),
            );
          let promise: Promise<StepResult>;
          if (step.recover) {
            const recoverLimit = this.resolveRecoverLimit(scope.filePath);
            const recover = step.recover;
            promise = runInBranch(async () => {
              let lastResult = await this.executeRunRef(scope, ref, argsRaw);
              let attempt = 1;
              while (lastResult.status !== 0 && attempt <= recoverLimit) {
                const rr = await this.runRecoverBody(scope, recover, `${lastResult.output}${lastResult.error}`);
                if (rr.status !== 0 || rr.returnValue !== undefined) return rr;
                lastResult = await this.executeRunRef(scope, ref, argsRaw);
                attempt += 1;
              }
              return lastResult;
            });
          } else if (step.catch) {
            const recover = step.catch;
            promise = runInBranch(async () => {
              const result = await this.executeRunRef(scope, ref, argsRaw);
              if (result.status === 0) return result;
              const rr = await this.runRecoverBody(scope, recover, `${result.output}${result.error}`);
              if (rr.status !== 0) return rr;
              if (rr.returnValue !== undefined) return { ...rr, recoverReturn: true };
              return { status: 0, output: result.output, error: result.error };
            });
          } else {
            promise = runInBranch(() => this.executeRunRef(scope, ref, argsRaw));
          }
          const handleId = this.createHandle(ref, promise);
          localHandleIds.push(handleId);
          if (step.captureName) scope.vars.set(step.captureName, handleId);
          continue;
        }
        if (body.kind === "call") {
          if (step.recover) {
            const limit = this.resolveRecoverLimit(scope.filePath);
            const ref = body.callee.value;
            const argsRaw = argsToRuntimeString(body.args);
            let lastResult = await this.executeRunRef(scope, ref, argsRaw);
            let attempt = 1;
            while (lastResult.status !== 0 && attempt <= limit) {
              const rr = await this.runRecoverBody(scope, step.recover, `${lastResult.output}${lastResult.error}`);
              if (rr.status !== 0 || rr.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, rr);
              lastResult = await this.executeRunRef(scope, ref, argsRaw);
              attempt += 1;
            }
            if (lastResult.status === 0) {
              if (step.captureName) {
                scope.vars.set(step.captureName, lastResult.returnValue ?? lastResult.output.trim());
              }
            } else {
              return this.mergeStepResult(accOut, accErr, lastResult);
            }
            continue;
          }
          const runResult = await this.executeRunRef(scope, body.callee.value, argsToRuntimeString(body.args));
          if (runResult.status === 0) {
            if (step.captureName) {
              scope.vars.set(step.captureName, runResult.returnValue ?? runResult.output.trim());
            }
          } else if (step.catch) {
            const rr = await this.runRecoverBody(scope, step.catch, `${runResult.output}${runResult.error}`);
            if (rr.status !== 0 || rr.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, rr);
          } else {
            return this.mergeStepResult(accOut, accErr, runResult);
          }
          continue;
        }
        if (body.kind === "ensure_call") {
          const ensureResult = await this.executeEnsureRef(scope, body.callee.value, argsToRuntimeString(body.args), step.catch);
          if (step.captureName && ensureResult.status === 0) {
            scope.vars.set(step.captureName, ensureResult.returnValue ?? ensureResult.output.trim());
          }
          if (ensureResult.status !== 0) return this.mergeStepResult(accOut, accErr, ensureResult);
          if (ensureResult.recoverReturn) return this.mergeStepResult(accOut, accErr, ensureResult);
          continue;
        }
        if (body.kind === "inline_script") {
          const shebang = body.lang ? `#!/usr/bin/env ${body.lang}` : undefined;
          const argsRaw = argsToRuntimeString(body.args);
          const runOnce = (): Promise<StepResult> =>
            this.executeInlineScript(scope, body.body, shebang, argsRaw);
          if (step.recover) {
            const limit = this.resolveRecoverLimit(scope.filePath);
            let lastResult = await runOnce();
            let attempt = 1;
            while (lastResult.status !== 0 && attempt <= limit) {
              const rr = await this.runRecoverBody(scope, step.recover, `${lastResult.output}${lastResult.error}`);
              if (rr.status !== 0 || rr.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, rr);
              lastResult = await runOnce();
              attempt += 1;
            }
            if (lastResult.status === 0) {
              if (step.captureName) {
                scope.vars.set(step.captureName, lastResult.returnValue ?? lastResult.output.trim());
              }
            } else {
              return this.mergeStepResult(accOut, accErr, lastResult);
            }
            continue;
          }
          const result = await runOnce();
          if (result.status === 0) {
            if (step.captureName) {
              scope.vars.set(step.captureName, result.returnValue ?? result.output.trim());
            }
          } else if (step.catch) {
            const rr = await this.runRecoverBody(scope, step.catch, `${result.output}${result.error}`);
            if (rr.status !== 0 || rr.returnValue !== undefined) return this.mergeStepResult(accOut, accErr, rr);
          } else {
            return this.mergeStepResult(accOut, accErr, result);
          }
          continue;
        }
        if (body.kind === "prompt") {
          if (body.returns !== undefined && !step.captureName) {
            return this.mergeStepResult(accOut, accErr, {
              status: 1,
              output: "",
              error: 'prompt with "returns" schema must capture to a variable',
            });
          }
          const r = await this.runPromptStep(scope, body.raw, body.returns, step.captureName, io);
          accOut += r.output;
          if (!r.ok) return this.mergeStepResult(accOut, accErr, r.result);
          continue;
        }
        if (body.kind === "match") {
          const matchResult = await this.evaluateMatch(scope, body.match);
          if (!matchResult.ok) return this.mergeStepResult(accOut, accErr, matchResult.result);
          if (step.captureName) scope.vars.set(step.captureName, matchResult.value);
          continue;
        }
        if (body.kind === "shell") {
          const cmdIr = await this.interpolateWithCaptures(body.command, scope);
          if (!cmdIr.ok) return this.mergeStepResult(accOut, accErr, cmdIr.result);
          const stepName = `sh_line_${body.loc.line}`;
          const result = await this.executeManagedStep(
            "script",
            stepName,
            [],
            (io) => this.executeShLine(scope, cmdIr.value, io),
          );
          if (step.captureName && result.status === 0) {
            scope.vars.set(step.captureName, result.returnValue ?? result.output.trim());
          }
          if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
          continue;
        }
        return this.mergeStepResult(accOut, accErr, {
          status: 1,
          output: "",
          error: `unsupported exec body kind in runtime: ${body.kind}`,
        });
      }
      if (step.type === "if") {
        const resolved = await this.resolveSubjectValue(scope, step.subject);
        if (!resolved.ok) return this.mergeStepResult(accOut, accErr, resolved.result);
        const subjectVal = resolved.value;
        let condMet = false;
        if (step.operator === "==" && step.operand.kind === "string_literal") {
          condMet = subjectVal === step.operand.value;
        } else if (step.operator === "!=" && step.operand.kind === "string_literal") {
          condMet = subjectVal !== step.operand.value;
        } else if (step.operator === "=~" && step.operand.kind === "regex") {
          condMet = new RegExp(step.operand.source).test(subjectVal);
        } else if (step.operator === "!~" && step.operand.kind === "regex") {
          condMet = !new RegExp(step.operand.source).test(subjectVal);
        }
        const branch = condMet ? step.body : step.elseBody;
        if (branch) {
          const bodyResult = await this.executeSteps(scope, branch, io);
          if (bodyResult.status !== 0 || bodyResult.returnValue !== undefined) {
            return this.mergeStepResult(accOut, accErr, bodyResult);
          }
          accOut += bodyResult.output;
          accErr += bodyResult.error;
        }
        continue;
      }
      if (step.type === "for_lines") {
        const raw =
          scope.vars.get(step.sourceVar) ??
          scope.env?.[step.sourceVar] ??
          "";
        for (const line of linesOfDelimitedString(raw)) {
          scope.vars.set(step.iterVar, line);
          const bodyResult = await this.executeSteps(scope, step.body, io);
          if (bodyResult.status !== 0 || bodyResult.returnValue !== undefined) {
            return this.mergeStepResult(accOut, accErr, bodyResult);
          }
          accOut += bodyResult.output;
          accErr += bodyResult.error;
        }
        continue;
      }
    }
    // Implicit join: await all unresolved handles created in this scope before returning.
    if (localHandleIds.length > 0) {
      const failures: string[] = [];
      const collectResult = (handleRef: string, result: StepResult): void => {
        if (result.status !== 0) {
          failures.push(`run async ${handleRef}: ${result.error}`);
          accOut += result.output;
          accErr += result.error;
        } else {
          accOut += result.output;
          // An async branch that recovered via `return X` propagates that value
          // to the parent workflow, mirroring sync ensure/run+catch semantics.
          if (result.recoverReturn && result.returnValue !== undefined && returnValue === undefined) {
            returnValue = result.returnValue;
          }
        }
      };
      for (const handleId of localHandleIds) {
        const handle = this.handleRegistry.get(handleId);
        if (!handle) continue;
        if (handle.resolved) {
          collectResult(handle.ref, handle.resolved);
          continue;
        }
        try {
          const result = await this.resolveHandleResult(handleId);
          collectResult(handle.ref, result);
        } catch (err) {
          failures.push(`run async ${handle.ref}: ${String(err)}`);
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
    const limit = resolveInboxDispatchLimit(this.env);
    let cursor = 0;
    while (cursor < ctx.queue.length) {
      if (cursor >= limit) {
        const blocker = ctx.queue[cursor]!;
        return {
          status: 1,
          output: "",
          error: `E_INBOX_DISPATCH_LIMIT: drained ${limit} messages without quiescing — likely a circular send (channel "${blocker.channel}"); raise JAIPH_INBOX_MAX_DISPATCH if intentional`,
        };
      }
      const msg = ctx.queue[cursor]!;
      cursor += 1;
      const targets = ctx.routes.get(msg.channel) ?? [];
      if (targets.length === 0) continue;
      const inboxArgs = [msg.content, msg.channel, msg.sender];
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
          inboxArgs,
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
    return { status: 0, output: "", error: "" };
  }

  private mockKey(filePath: string, name: string): string {
    return `${filePath}::${name}`;
  }

  private dispatchMockBody(ref: string, mockDef: MockBodyDef, args: string[]): Promise<StepResult> {
    return executeMockBodyDef({
      ref,
      mockDef,
      args,
      env: this.env,
      cwd: this.cwd,
      executeStepsBack: (params, stepArgs, steps) => {
        const scope: Scope = {
          filePath: this.graph.entryFile,
          vars: new Map<string, string>(),
          env: { ...this.env },
          declaredParamNames: params,
        };
        params.forEach((name, i) => {
          if (i < stepArgs.length) scope.vars.set(name, stepArgs[i]);
        });
        return this.executeSteps(scope, steps);
      },
    });
  }

  private async resolveArgsRaw(scope: Scope, raw: string | string[]): Promise<string[] | StepResult> {
    if (Array.isArray(raw)) {
      return raw;
    }
    const tokens = parseArgTokens(raw);
    const resolved: string[] = [];
    for (const token of tokens) {
      if (token.kind === "literal") {
        // Resolve handles before interpolating.
        const handleErr = await this.resolveHandlesInInput(scope, token.value);
        if (handleErr) return handleErr;
        resolved.push(interpolate(token.value, scope.vars, scope.env));
        continue;
      }
      if (token.kind === "managed_inline_script") {
        const result = await this.executeInlineScript(scope, token.body, undefined, token.argsRaw);
        if (result.status !== 0) return result;
        resolved.push(result.returnValue ?? result.output.trim());
        continue;
      }
      const result = token.managedKind === "run"
        ? await this.executeRunRef(scope, token.ref, token.argsRaw)
        : await this.executeEnsureRef(scope, token.ref, token.argsRaw, undefined);
      if (result.status !== 0) {
        return result;
      }
      resolved.push(result.returnValue ?? result.output.trim());
    }
    return resolved;
  }

  private async executeRunRef(scope: Scope, ref: string, argsRaw: string | string[]): Promise<StepResult> {
    const resolvedArgs = await this.resolveArgsRaw(scope, argsRaw);
    if (!Array.isArray(resolvedArgs)) return resolvedArgs;
    const args = resolvedArgs;
    const resolvedWorkflow = resolveWorkflowRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
    if (resolvedWorkflow) {
      const mk = this.mockKey(resolvedWorkflow.filePath, resolvedWorkflow.workflow.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep(
          "workflow",
          ref,
          args,
          async () => this.dispatchMockBody(ref, mockBody, args),
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
        return this.executeManagedStep("script", ref, args, async () => this.dispatchMockBody(ref, mockBody, args));
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

  /**
   * Execute a prompt step, stream output to artifacts, and bind the captured
   * value (and per-field exports when a returns schema is set) into `scope`.
   * Returns the chunk of stdout to add to the caller's accumulator.
   *
   * Transport-failure backoff: a non-zero exit from `executePrompt` (spawn
   * failure, backend non-zero exit, codex HTTP error) is retried on the
   * configured delay schedule (default: 15s → 1m → 10m → 30m → 2h, 6 attempts
   * total). Each attempt is a fresh `executePrompt` call with its own
   * PROMPT_START/PROMPT_END and STEP_START/STEP_END events. Backoff composes
   * *below* `recover`/`catch`: retries are exhausted before the failure
   * reaches the enclosing recover loop. Deterministic post-processing
   * failures (invalid JSON, schema validation) are not retried — they fail
   * identically on re-run.
   */
  private async runPromptStep(
    scope: Scope,
    raw: string,
    returns: string | undefined,
    captureName: string | undefined,
    io: StepIO | undefined,
  ): Promise<{ ok: true; output: string } | { ok: false; result: StepResult; output: string }> {
    const promptIr = await this.interpolateWithCaptures(raw, scope);
    if (!promptIr.ok) return { ok: false, result: promptIr.result, output: "" };
    let promptText = promptIr.value;
    const promptConfig = resolveConfig(scope.env);
    const backend = promptConfig.backend || "cursor";
    const stepName = resolvePromptStepName(promptConfig);
    const modelRes = resolveModel(promptConfig);
    let schemaFields: PromptSchemaField[] | undefined;
    if (returns !== undefined) {
      schemaFields = parsePromptSchema(returns);
      const schemaObject = Object.fromEntries(schemaFields.map((f) => [f.name, f.type]));
      promptText +=
        "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
        JSON.stringify(schemaObject);
    }
    const delaysRes = this.getPromptRetryDelays();
    if (!delaysRes.ok) {
      this.emitter.emitLog("LOGERR", `prompt retry config invalid: ${delaysRes.error}`);
      return { ok: false, result: { status: 1, output: "", error: delaysRes.error }, output: "" };
    }
    const delays = delaysRes.delays;
    const totalAttempts = delays.length + 1;

    let lastOutput = "";
    let lastResult: StepResult = { status: 1, output: "", error: "prompt failed" };
    let lastFinal = "";

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      if (this.abortController.signal.aborted) {
        this.emitter.emitLog(
          "LOGERR",
          `prompt aborted before attempt ${attempt}/${totalAttempts} (${backend}); retries halted`,
        );
        return {
          ok: false,
          result: { status: lastResult.status || 1, output: "", error: "prompt retry aborted" },
          output: lastOutput,
        };
      }
      const promptStep = this.emitter.emitPromptStepStart(stepName, scope.vars, raw);
      this.emitter.emitPromptEvent("PROMPT_START", {
        backend,
        model: modelRes.model || undefined,
        model_reason: modelRes.reason,
        preview: promptText.slice(0, 120),
      });
      const out = new PassThrough();
      const chunks: string[] = [];
      const err = new PassThrough();
      const errChunks: string[] = [];
      out.on("data", (d) => {
        const chunk = String(d);
        chunks.push(chunk);
        appendFileSync(promptStep.outFile, chunk);
        io?.appendOut(chunk);
      });
      err.on("data", (d) => {
        const chunk = String(d);
        errChunks.push(chunk);
        io?.appendErr(chunk);
      });
      const result = await executePrompt(promptText, promptConfig, out, scope.env, err);
      const promptErr = errChunks.join("");
      this.emitter.emitPromptStepEnd(promptStep, result.status, chunks.join(""), promptErr);
      this.emitter.emitPromptEvent("PROMPT_END", {
        backend,
        model: modelRes.model || undefined,
        model_reason: modelRes.reason,
        status: result.status,
      });
      lastOutput = chunks.join("");
      lastFinal = result.final;
      lastResult = {
        status: result.status,
        output: "",
        error: promptErr.trim() || "prompt failed",
      };
      if (result.status === 0) break;
      // Transport failure path: log + (sleep + retry) or terminate.
      const errSummary = summarizeError(lastResult.error ?? "");
      if (attempt >= totalAttempts) {
        this.emitter.emitLog(
          "LOGERR",
          `prompt attempt ${attempt}/${totalAttempts} failed (${backend}): ${errSummary}; retries exhausted, failing step`,
        );
        return { ok: false, result: lastResult, output: lastOutput };
      }
      const nextDelayMs = delays[attempt - 1]!;
      const nextDelayLabel = formatRetryDelay(nextDelayMs);
      this.emitter.emitLog(
        "LOGERR",
        `prompt attempt ${attempt}/${totalAttempts} failed (${backend}): ${errSummary}; retrying in ${nextDelayLabel}`,
      );
      try {
        await this.sleep(nextDelayMs, this.abortController.signal);
      } catch (sleepErr) {
        if (isPromptRetryAbortError(sleepErr) || this.abortController.signal.aborted) {
          this.emitter.emitLog(
            "LOGERR",
            `prompt retry aborted during backoff after attempt ${attempt}/${totalAttempts} (${backend}); retries halted`,
          );
          return {
            ok: false,
            result: { status: lastResult.status || 1, output: "", error: "prompt retry aborted" },
            output: lastOutput,
          };
        }
        throw sleepErr;
      }
    }

    if (schemaFields) {
      const extracted = extractJson(lastFinal);
      if (!extracted) {
        return {
          ok: false,
          result: { status: 1, output: "", error: "prompt returned invalid JSON" },
          output: lastOutput,
        };
      }
      const validation = validateFields(extracted.obj, schemaFields);
      if (validation !== 0) {
        return {
          ok: false,
          result: { status: validation, output: "", error: "prompt response failed schema validation" },
          output: lastOutput,
        };
      }
      if (captureName) {
        scope.vars.set(captureName, extracted.source);
        for (const field of schemaFields) {
          scope.vars.set(`${captureName}_${field.name}`, String(extracted.obj[field.name]));
        }
      }
    } else if (captureName) {
      scope.vars.set(captureName, lastFinal);
    }
    return { ok: true, output: lastOutput };
  }

  /** Run a recover/catch body with `failure` bound to the failed step's payload. */
  private async runRecoverBody(
    scope: Scope,
    catchDef: { bindings: { failure: string } } & (
      | { single: WorkflowStepDef }
      | { block: WorkflowStepDef[] }
    ),
    failurePayload: string,
  ): Promise<StepResult> {
    const recoverSteps = "single" in catchDef ? [catchDef.single] : catchDef.block;
    const recoverVars = new Map(scope.vars);
    recoverVars.set(catchDef.bindings.failure, failurePayload);
    return this.executeSteps({ ...scope, vars: recoverVars }, recoverSteps);
  }

  private async executeEnsureRef(
    scope: Scope,
    ref: string,
    argsRaw: string,
    catchDef: CatchBody | undefined,
  ): Promise<StepResult> {
    const resolvedArgs = await this.resolveArgsRaw(scope, argsRaw);
    if (!Array.isArray(resolvedArgs)) return resolvedArgs;
    const args = resolvedArgs;
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
          async () => this.dispatchMockBody(ref, mockBody, args),
          resolvedRule.rule.params,
        );
      }
      return this.executeRule(resolvedRule.filePath, resolvedRule.rule.name, scope, args);
    };
    const res = await attempt();
    if (res.status === 0) return res;
    if (!catchDef) return res;
    const rr = await this.runRecoverBody(scope, catchDef, `${res.output}${res.error}`);
    if (rr.status !== 0) return rr;
    if (rr.returnValue !== undefined) return { ...rr, recoverReturn: true };
    return { status: 0, output: res.output, error: "" };
  }

  /**
   * Spawn a child process, stream stdout/stderr into io and collect them into
   * the StepResult. When `interpreter` is set, a spawn ENOENT (the interpreter
   * binary is missing on PATH) is turned into a diagnosable Jaiph error naming
   * the interpreter instead of a raw `spawn <name> ENOENT`.
   */
  private spawnAndCapture(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    io: StepIO | undefined,
    interpreter?: string,
  ): Promise<StepResult> {
    return new Promise((resolve) => {
      const child = _scriptSpawn.spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
        const code = (err as NodeJS.ErrnoException).code;
        const msg = code === "ENOENT" && interpreter
          ? `script interpreter "${interpreter}" not found — install it or fix the script shebang`
          : err instanceof Error ? err.message : String(err);
        error += msg;
        io?.appendErr(msg);
        resolve({ status: 1, output, error });
      });
      child.on("close", (code) => {
        const status = typeof code === "number" ? code : 1;
        resolve({
          status,
          output,
          error,
          ...(status === 0 ? { returnValue: output.trim() } : {}),
        });
      });
    });
  }

  private scriptCwd(env: NodeJS.ProcessEnv, fallbackFilePath: string): string {
    return env.JAIPH_WORKSPACE && env.JAIPH_WORKSPACE.length > 0
      ? env.JAIPH_WORKSPACE
      : dirname(fallbackFilePath);
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
    const interp = this.resolveScriptInterpreter(scriptPath);
    if (!interp.ok) return { status: 1, output: "", error: interp.error };
    // Spawn `<interpreter> <scriptPath> <args...>` explicitly. This does not
    // depend on the OS honoring the shebang line (Windows) or on the file's
    // exec bit (stripped bit / `noexec` mounts); the shebang is still written
    // into the file so it stays directly executable by hand on POSIX.
    return this.spawnAndCapture(
      interp.command,
      [...interp.prefixArgs, scriptPath, ...args],
      env,
      this.scriptCwd(env, filePath),
      io,
      interp.command,
    );
  }

  /**
   * Resolve the interpreter to spawn for an emitted script from its shebang
   * line. Emitted scripts always carry a shebang (`buildScriptFiles`); a script
   * without one falls back to bash (Jaiph's default script language) rather
   * than depending on the OS exec bit.
   */
  private resolveScriptInterpreter(
    scriptPath: string,
  ): { ok: true; command: string; prefixArgs: string[] } | { ok: false; error: string } {
    let firstLine: string;
    try {
      const content = readFileSync(scriptPath, "utf8");
      const nl = content.indexOf("\n");
      firstLine = nl === -1 ? content : content.slice(0, nl);
    } catch {
      return { ok: false, error: `script file not found or unreadable: ${scriptPath}` };
    }
    const interp = resolveInterpreterFromShebang(firstLine);
    if (!interp) return { ok: true, command: "bash", prefixArgs: [] };
    return { ok: true, command: interp.command, prefixArgs: interp.prefixArgs };
  }

  /**
   * Run a raw workflow shell line (after Jaiph interpolation) via `sh -c` in
   * the workspace, matching script cwd semantics.
   */
  private executeShLine(scope: Scope, command: string, io: StepIO): Promise<StepResult> {
    return this.spawnAndCapture(resolveShell(), ["-c", command], scope.env, this.scriptCwd(scope.env, scope.filePath), io);
  }

  private async executeInlineScript(
    scope: Scope,
    body: string,
    shebang: string | undefined,
    argsRaw: string,
  ): Promise<StepResult> {
    const resolvedArgs = await this.resolveArgsRaw(scope, argsRaw);
    if (!Array.isArray(resolvedArgs)) return resolvedArgs;
    const args = resolvedArgs;
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
    vars?: Map<string, string>,
  ): NodeJS.ProcessEnv {
    const nextEnv: NodeJS.ProcessEnv = { ...parentEnv };
    const apply = (meta?: WorkflowMetadata): void => {
      if (!meta) return;
      const resolved = vars ? interpolateWorkflowMetadata(meta, vars, parentEnv) : meta;
      if (parentEnv.JAIPH_AGENT_MODEL_LOCKED !== "1" && resolved.agent?.defaultModel !== undefined) {
        nextEnv.JAIPH_AGENT_MODEL = resolved.agent.defaultModel;
      }
      if (parentEnv.JAIPH_AGENT_COMMAND_LOCKED !== "1" && resolved.agent?.command !== undefined) {
        nextEnv.JAIPH_AGENT_COMMAND = resolved.agent.command;
      }
      if (parentEnv.JAIPH_AGENT_BACKEND_LOCKED !== "1" && resolved.agent?.backend !== undefined) {
        nextEnv.JAIPH_AGENT_BACKEND = resolved.agent.backend;
      }
      if (
        parentEnv.JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED !== "1" &&
        resolved.agent?.trustedWorkspace !== undefined
      ) {
        nextEnv.JAIPH_AGENT_TRUSTED_WORKSPACE = resolved.agent.trustedWorkspace;
      }
      if (parentEnv.JAIPH_AGENT_CURSOR_FLAGS_LOCKED !== "1" && resolved.agent?.cursorFlags !== undefined) {
        nextEnv.JAIPH_AGENT_CURSOR_FLAGS = resolved.agent.cursorFlags;
      }
      if (parentEnv.JAIPH_AGENT_CLAUDE_FLAGS_LOCKED !== "1" && resolved.agent?.claudeFlags !== undefined) {
        nextEnv.JAIPH_AGENT_CLAUDE_FLAGS = resolved.agent.claudeFlags;
      }
      if (parentEnv.JAIPH_RUNS_DIR_LOCKED !== "1" && resolved.run?.logsDir !== undefined) {
        nextEnv.JAIPH_RUNS_DIR = resolved.run.logsDir;
      }
      if (parentEnv.JAIPH_DEBUG_LOCKED !== "1" && resolved.run?.debug !== undefined) {
        nextEnv.JAIPH_DEBUG = resolved.run.debug ? "true" : "false";
      }
    };
    apply(moduleMeta);
    apply(workflowMeta);
    return nextEnv;
  }

  private resolveRecoverLimit(filePath: string): number {
    const activeWorkflowMeta = this.workflowCtxStack[this.workflowCtxStack.length - 1]?.workflowMeta;
    if (activeWorkflowMeta?.run?.recoverLimit !== undefined) {
      return activeWorkflowMeta.run.recoverLimit;
    }
    const moduleMeta = this.graph.modules.get(filePath)?.ast.metadata;
    return moduleMeta?.run?.recoverLimit ?? 10;
  }

  private async executeManagedStep(
    kind: "workflow" | "rule" | "script",
    name: string,
    args: string[],
    fn: (io: StepIO) => Promise<StepResult>,
    declaredParamNames?: string[],
  ): Promise<StepResult> {
    const seq = this.emitter.allocStepSeq();
    const safe = sanitizeName(`${kind}__${name}`);
    const outFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.out`);
    const errFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.err`);
    const stack = this.getFrameStack();
    const parentId = stack.length > 0 ? stack[stack.length - 1]!.id : null;
    const id = `${this.runId}:${process.pid}:${seq}`;
    const depth = stack.length;
    if (depth > MAX_RECURSION_DEPTH) {
      return { status: 1, output: "", error: `Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded at ${kind} ${name}` };
    }
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
    this.emitter.emitStep({
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
    this.emitter.emitStep({
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
}
