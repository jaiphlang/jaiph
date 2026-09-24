import { spawn } from "node:child_process";
import { errText } from "../../errors";
import { appendFileSync, closeSync, copyFileSync, createReadStream, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inlineScriptName, nestedScriptName } from "../../inline-script-name";
import {
  argsToRuntimeString,
  canonicalizeTripleQuotedString,
  resolveInterpreterFromShebang,
} from "../../parser";
import type { CatchBody, Def, Expr, LocalDecl, MatchExprDef, MatchPatternDef, StepDef } from "../../types";
import {
  executePrompt,
  modelForStepEvent,
  promptBodyOffArgv,
  resolveConfig,
  resolveModel,
  resolvePromptConfig,
  resolvePromptStepName,
  shellQuote,
  type PromptSource,
} from "./prompt";
import { appendRunSummaryLine, CHAIN_KEY_ENV } from "./emit";
import { buildStepDisplayParamPairs } from "./format-params";
import { resolveScriptRef, resolveDefRef, resolvePromptRef, type RuntimeGraph } from "./graph";
import type { DefMetadata } from "../../types";
import { interpolateDefMetadata } from "../../config";
import { extractJson, validateFields } from "./schema";
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
import { killProcessTreeEscalating, resolveShell } from "./portability";
import { RuntimeEventEmitter, type Frame } from "./runtime-event-emitter";
import { createStepIdleOutputWarn } from "./step-idle-warn";
import { parseMaxSteps, maxStepsTrippedMessage } from "./max-steps";
import { executeMockBodyDef, type MockBodyDef, type StepResult } from "./runtime-mock";
import { resetMockResponses } from "./mock";
import { buildScriptEnv, parseEnvGrant } from "./env-allowlist";
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

/**
 * Byte size of the argv + env block a spawn would have to pass to the kernel.
 * Mirrors the exec(3) accounting the OS uses when it rejects with `E2BIG`:
 * every argv string and every `KEY=VALUE` env pair costs its UTF-8 length plus
 * one NUL terminator. Used only to annotate an oversized-argv failure with the
 * attempted size — a diagnostic, not a hard limit check.
 */
function argvEnvByteSize(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  let bytes = Buffer.byteLength(command) + 1;
  for (const a of args) bytes += Buffer.byteLength(a) + 1;
  for (const key of Object.keys(env)) {
    const val = env[key];
    if (val === undefined) continue;
    // KEY=VALUE plus the NUL terminator (the `=` is the +1 inside byteLength math below).
    bytes += Buffer.byteLength(key) + 1 + Buffer.byteLength(val) + 1;
  }
  return bytes;
}

/**
 * Diagnostic stderr text for a spawn failure, shared by the synchronous-throw
 * and asynchronous `'error'`-event paths so both settle identically. `E2BIG`
 * (argv + env exceed the OS `ARG_MAX`) maps to a stable `E_ARGV_TOO_LARGE`
 * marker carrying the attempted byte count; a missing interpreter keeps its
 * existing diagnosable wording; anything else falls back to the raw error text.
 */
function spawnFailureText(
  err: unknown,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  interpreter: string | undefined,
): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "E2BIG") {
    const bytes = argvEnvByteSize(command, args, env);
    return `E_ARGV_TOO_LARGE: ${bytes} bytes (ARG_MAX exceeded)`;
  }
  if (code === "ENOENT" && interpreter) {
    return `script interpreter "${interpreter}" not found — install it or fix the script shebang`;
  }
  return errText(err);
}

export function formatInvalidAsyncHandleError(handleId: string): string {
  return `invalid async handle "${handleId}" — the handle was never created or was already consumed`;
}

/**
 * Error surfaced when a `send` step executes with no enclosing def context on
 * the stack. Defensive: the parser only accepts `send` inside a def body and
 * `executeDef` always pushes a context, so this is not reachable through the
 * normal compile+run path — exported so the operator-facing wording (`def`, not
 * the retired `workflow` noun) is pinned by a unit test.
 */
export const SEND_OUTSIDE_DEF_CONTEXT_ERROR = "send is only valid inside def execution context";

const DEFAULT_INBOX_DISPATCH_LIMIT = 1000;

function resolveInboxDispatchLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.JAIPH_INBOX_MAX_DISPATCH;
  if (raw === undefined || raw === "") return DEFAULT_INBOX_DISPATCH_LIMIT;
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_INBOX_DISPATCH_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INBOX_DISPATCH_LIMIT;
  return n;
}

/** Match-arm pattern predicate; alternation matches if any alternand matches (OR). */
function patternMatches(pattern: MatchPatternDef, subject: string): boolean {
  if (pattern.kind === "wildcard") return true;
  if (pattern.kind === "string_literal") return subject === pattern.value;
  if (pattern.kind === "regex") return new RegExp(pattern.source).test(subject);
  return pattern.patterns.some((p) => patternMatches(p, subject));
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
  /**
   * Nested (def-local) declarations registered so far in this def body:
   * `script` / `def` / named `prompt`. Populated sequentially as `local_decl`
   * steps execute, so a name resolves only after its declaration and shadows a
   * module-level symbol of the same name.
   */
  locals?: Map<string, LocalDecl>;
};

/** Name a nested declaration binds in its enclosing def scope. */
function localDeclName(decl: LocalDecl): string {
  if (decl.kind === "script") return decl.script.name;
  if (decl.kind === "def") return decl.def.name;
  return decl.prompt.name;
}

/**
 * A block-local child scope for an `if` / `else` / `for` / `catch` / `recover`
 * body. `vars` and `locals` are copied so a nested `const` / capture / iterator
 * / `script` / `def` / `prompt` declared inside the body is visible for the rest
 * of that body but does not leak past it — mirroring the validator's block
 * scope, so a shadow inside a branch never overwrites the enclosing binding.
 */
function blockChildScope(scope: Scope): Scope {
  return {
    ...scope,
    vars: new Map(scope.vars),
    locals: scope.locals ? new Map(scope.locals) : undefined,
  };
}

/**
 * Where a `stdin <value> -> script()` connect gets the bytes it feeds to the
 * child. A small value already resolved in scope (a string, a `${…}` ref) is
 * `bytes`; an output handle from a completed producer (a def call, or a bound
 * `recover`/`catch` failure) is `file` — the child reads it as a stream from
 * disk, so a multi-megabyte producer is never slurped into a JS string first.
 * An `fd` source is the still-running previous stage's live stdout: in a
 * pipeline (`stdin gen() -> upper() -> count()`) the stages run concurrently.
 * Each stage tees its stdout — writes the `.out` capture chunk-by-chunk and
 * pipes the same stream into the next stage's stdin — so producer and consumer
 * overlap, peak RSS does not track the payload, and the audit log is complete.
 */
type StdinSource =
  | { kind: "bytes"; bytes: string }
  | { kind: "file"; path: string }
  | { kind: "fd"; stream: Readable };

type StepIO = {
  // Accept `Buffer` so a leaf's stdout can be streamed to disk without decoding
  // each chunk into a V8 string — 64 MiB of stdout would otherwise churn the JS
  // heap with transient string garbage and inflate peak RSS even though nothing
  // is retained. `log` lines and prompt output still pass strings.
  appendOut: (chunk: string | Buffer) => void;
  appendErr: (chunk: string | Buffer) => void;
  /**
   * When set, aborting this signal terminates the leaf-step subprocess spawned
   * in `spawnAndCapture` (SIGTERM → SIGKILL) so the idle-output kill watchdog
   * can stop a step that has gone silent. Only wired for `script` steps.
   */
  killSignal?: AbortSignal;
};

type InboxMsg = {
  channel: string;
  content: string;
  sender: string;
  seqPadded: string;
};

type WorkflowContext = {
  defName: string;
  routes: Map<string, string[]>;
  queue: InboxMsg[];
  defMeta?: DefMetadata;
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
  private defCtxStack: WorkflowContext[] = [];
  private readonly mockBodies: Map<string, MockBodyDef>;
  private handleRegistry = new Map<string, AsyncHandle>();
  private handleIdCounter = 0;
  private recoverMergeCounter = 0;
  private readonly abortController = new AbortController();
  /**
   * Optional max-step circuit breaker (`JAIPH_MAX_STEPS`, `0` = disabled).
   * `stepsExecuted` counts every executed non-trivia step across the whole run
   * (loop iterations and nested/recursive calls included); once it exceeds
   * `maxSteps` the run is aborted. See `max-steps.ts`.
   */
  private readonly maxSteps: number;
  private stepsExecuted = 0;
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
  /**
   * The `--env` grant VALUE map — the only source of granted `use` values.
   * Passed in off-process (never on `this.env`): the CLI writes the values to a
   * grant file and the runner reads them here (see `env-grant-file.ts`). Ungranted
   * host keys are absent from both this map and the runner env. A script's / named
   * prompt's granted `use` key resolves against this map, gated by `envGrantKeys`.
   */
  private readonly grantValues: Record<string, string>;
  /** Keys the operator granted via `--env` (`JAIPH_ENV_GRANT`, see env-allowlist.ts). */
  private readonly envGrantKeys: Set<string>;

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

  /**
   * Slurp a step result's output handle to the string a force site sees
   * (`const x = call()`, `${x}` interpolation, argv, `if`/`match` subject).
   * An eager `returnValue` (def `return "…"`, prompt answer, match value) wins;
   * otherwise the bytes live in `valueFile` on disk and are read + trimmed here
   * — this is the one place a call result is materialized into V8, and it may
   * be a multi-megabyte (OOM-able) read by design. Falls back to the in-memory
   * `output` for results that never wrote a capture file.
   */
  private forceValue(r: StepResult): string {
    if (r.returnValue !== undefined) return r.returnValue;
    if (r.valueFile) {
      try {
        return readFileSync(r.valueFile, "utf8").trim();
      } catch {
        return "";
      }
    }
    return (r.output ?? "").trim();
  }

  /**
   * Register an already-resolved output handle (no pending promise). Used for a
   * `recover`/`catch` binding: the failed step's stdout capture becomes a
   * status-0 handle so `${failure}` slurps its CONTENTS and `stdin failure ->`
   * streams the file — never a run-dir path.
   */
  private createResolvedHandle(ref: string, result: StepResult): string {
    this.handleIdCounter += 1;
    const handleId = `${HANDLE_PREFIX}${this.handleIdCounter}`;
    this.handleRegistry.set(handleId, { ref, promise: Promise.resolve(result), resolved: result });
    return handleId;
  }

  /**
   * True when a step result represents an executed `return` statement (as
   * opposed to falling off the end of a body). A `return "…"` sets an eager
   * `returnValue`; a `return <call>()` propagates an output handle via
   * `valueFile` with no eager value — both mean "this body returned", which
   * `if`/`for`/`catch`/`recover` bodies must detect to stop and propagate.
   */
  private stepReturned(r: StepResult): boolean {
    return r.returnValue !== undefined || r.valueFile !== undefined;
  }

  /** The stdin source a resolved output handle feeds to a `stdin -> script()` child. */
  private handleStdinSource(r: StepResult): StdinSource {
    if (r.returnValue !== undefined) return { kind: "bytes", bytes: r.returnValue };
    if (r.valueFile) return { kind: "file", path: r.valueFile };
    return { kind: "bytes", bytes: (r.output ?? "").trim() };
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
      scope.vars.set(varName, this.forceValue(result));
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
      /**
       * The `--env` grant VALUE map, supplied off-process (never on `env`). The
       * runner reads it from the grant file; `jaiph test` passes it directly.
       * Granted `use` keys (gated by `JAIPH_ENV_GRANT`) resolve from here.
       */
      grantValues?: Record<string, string>;
    },
  ) {
    this.graph = graph;
    // Fresh mock queue per run: identical JAIPH_MOCK_RESPONSES_JSON across two
    // runs must not share one exhausted queue (see resetMockResponses).
    resetMockResponses();
    this.env = opts.env ?? process.env;
    // Granted `use` values come from this off-process map, never from `this.env`
    // (which no longer carries `--env` values or ungranted host keys).
    this.grantValues = opts.grantValues ?? {};
    this.envGrantKeys = parseEnvGrant(this.env);
    this.maxSteps = parseMaxSteps(this.env);
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
    const dateDir = join(runsRoot, datePart);
    mkdirSync(dateDir, { recursive: true });
    this.runDir = join(dateDir, `${timePart}-${source}`);
    try {
      // Not recursive: an existing leaf directory must throw EEXIST here, not
      // succeed silently, so a same-second collision is detected below.
      mkdirSync(this.runDir, { recursive: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Two runs of the same source landed in the same UTC second — e.g.
      // concurrent `jaiph mcp`/`jaiph serve` calls hitting the same workflow
      // file. Reusing the colliding directory would let one run's
      // run_summary.jsonl / return_value.txt / step artifacts overwrite the
      // other's mid-flight, so disambiguate with this run's own id.
      const suffix = this.runId.replace(/-/g, "").slice(0, 8);
      this.runDir = join(dateDir, `${timePart}-${source}-${suffix}`);
      mkdirSync(this.runDir, { recursive: true });
    }
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
      // Credential redaction is name-based over env values. Grant values are off
      // `this.env` now, so fold them into the emitter's redaction view (trusted
      // kernel; not a subprocess env) or a granted credential would slip through
      // unredacted into the journal/event stream.
      env: { ...this.env, ...this.grantValues },
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

  async runMain(args: string[]): Promise<number> {
    return this.runRoot("main", args);
  }

  /**
   * Run a workflow from the entry module as the root of a run (same contract
   * as `runMain`, with the entry symbol parameterized): emits
   * RUN_START/END and persists `return_value.txt`. Used by `jaiph run`
   * (`main`) and by `jaiph mcp` tool calls (any exposed workflow).
   */
  async runRoot(defName: string, args: string[]): Promise<number> {
    this.emitter.emitRun("RUN_START", defName);
    // RUN_END and the heartbeat stop MUST happen even if the def body throws.
    // A vanished process is not a handleable error: the durable contract is a
    // terminal RUN_END, so emit it in `finally` regardless of how the body exits.
    try {
      const rootEnv = this.scrubKernelKeys({ ...this.env });
      const rootScope: Scope = {
        filePath: this.graph.entryFile,
        vars: this.newScopeVars(this.graph.entryFile, undefined, rootEnv),
        env: rootEnv,
      };
      const resolved = resolveDefRef(this.graph, this.graph.entryFile, {
        value: defName,
        loc: { line: 1, col: 1 },
      });
      if (!resolved) {
        process.stderr.write(
          defName === "main"
            ? "jaiph run requires `export def main` in the input file\n"
            : `jaiph run: unknown def '${defName}' in the input file\n`,
        );
        return 1;
      }
      // Bind CLI args to declared parameter names by position.
      resolved.def.params.forEach((name, i) => {
        if (i < args.length) rootScope.vars.set(name, args[i]);
      });
      const result = await this.executeDef(resolved.filePath, resolved.def.name, rootScope, args, false);
      // Persist the workflow's return value so the CLI can print it after the run tree.
      // Empty/undefined values are written as an empty file so the consumer can distinguish
      // "ran with no return" from "no run happened". When the return is an output
      // handle (`return <call>()`), copy its bytes at the OS level — the entry
      // def's return is streamed to the user, never slurped through V8 to print.
      if (result.status === 0 && (result.returnValue !== undefined || result.valueFile)) {
        const returnFile = join(this.runDir, "return_value.txt");
        try {
          if (result.returnValue !== undefined) {
            writeFileSync(returnFile, result.returnValue, "utf8");
          } else if (result.valueFile) {
            copyFileSync(result.valueFile, returnFile);
          }
        } catch {
          // Best-effort capture; the run succeeded regardless.
        }
      }
      return result.status;
    } finally {
      this.emitter.emitRun("RUN_END", defName);
      this.stopHeartbeat();
    }
  }

  async runNamedDef(ref: string, args: string[]): Promise<{ status: number; output: string; error?: string; returnValue?: string }> {
    const rootEnv = this.scrubKernelKeys({ ...this.env });
    const rootScope: Scope = {
      filePath: this.graph.entryFile,
      vars: this.newScopeVars(this.graph.entryFile, undefined, rootEnv),
      env: rootEnv,
    };
    const resolved = resolveDefRef(this.graph, this.graph.entryFile, {
      value: ref,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      this.stopHeartbeat();
      return { status: 1, output: `Unknown def: ${ref}` };
    }
    // Bind args to declared parameter names by position.
    resolved.def.params.forEach((name, i) => {
      if (i < args.length) rootScope.vars.set(name, args[i]);
    });
    const result = await this.executeDef(resolved.filePath, resolved.def.name, rootScope, args, false);
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

  private async executeDef(
    filePath: string,
    defName: string,
    scope: Scope,
    args: string[],
    inheritCallerMetadataScope: boolean,
  ): Promise<StepResult> {
    const resolved = resolveDefRef(this.graph, filePath, {
      value: defName,
      loc: { line: 1, col: 1 },
    });
    if (!resolved) {
      return { status: 1, output: "", error: `Unknown def: ${defName}` };
    }
    const callerModulePath = resolvePath(scope.filePath);
    const calleeModulePath = resolvePath(resolved.filePath);
    const crossModuleNested = callerModulePath !== calleeModulePath;
    return this.executeManagedStep("def", `${defName}`, args, async (io) => {
      const metadataVars = this.newScopeVars(resolved.filePath, scope.vars, scope.env);
      resolved.def.params.forEach((name, i) => {
        if (i < args.length) metadataVars.set(name, args[i]);
      });
      // Root entry (`runMain`, inheritCallerMetadataScope=false): apply entry module + workflow metadata.
      // Nested cross-module `run`: layer callee module + workflow metadata on top of the caller's
      // effective env (same mechanics as root entry, respecting `${NAME}_LOCKED`).  A module's
      // config describes how that module's workflows run, regardless of who called them.
      // Same-module nested `run`: apply only the callee def-level metadata (workflow boundaries
      // still apply within one module; module config is already in the caller's effective env).
      // Root call (`!inheritCallerMetadataScope`): the user explicitly invoked this workflow
      // (via `jaiph run` or the test runner `run w.wf()`), so its module config is trusted.
      // Nested cross-module calls: only the entry module is trusted for execution-binary keys.
      const fromEntryModule = !inheritCallerMetadataScope
        || calleeModulePath === resolvePath(this.graph.entryFile);
      // Same-module nested `run` layers only the callee def metadata(module config is already
      // in the caller's effective env); root entry and cross-module `run` both also apply the callee
      // module's metadata.
      const moduleMeta =
        inheritCallerMetadataScope && !crossModuleNested
          ? undefined
          : this.graph.modules.get(resolved.filePath)?.ast.metadata;
      const workflowEnv = this.applyMetadataScope(
        scope.env,
        moduleMeta,
        resolved.def.metadata,
        metadataVars,
        fromEntryModule,
      );
      const childScope: Scope = {
        filePath: resolved.filePath,
        vars: metadataVars,
        env: this.scrubKernelKeys(workflowEnv),
        declaredParamNames: resolved.def.params,
      };
      const ctx: WorkflowContext = {
        defName,
        routes: new Map(),
        queue: [],
        defMeta: resolved.def.metadata,
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
      this.defCtxStack.push(ctx);
      try {
        const out = await this.executeSteps(childScope, resolved.def.steps, io);
        if (out.status !== 0) return out;
        const drained = await this.drainWorkflowQueue(childScope, ctx);
        if (drained.status !== 0) return drained;
        return out;
      } finally {
        this.defCtxStack.pop();
      }
    }, resolved.def.params);
  }

  /**
   * Execute a nested (def-local) `def`. It is interpreted in-process and closes
   * over the enclosing def lexically: the child scope inherits the caller's
   * variables (params + `const`s) and its sibling nested declarations, then
   * binds its own parameters on top. It does not inherit a parent `use` (defs
   * have none) and does not push a new channel/route context — a nested def is
   * part of the enclosing def, not a separate module workflow.
   */
  private async executeLocalDef(callerScope: Scope, def: Def, args: string[]): Promise<StepResult> {
    return this.executeManagedStep("def", def.name, args, async (io) => {
      const childVars = new Map(callerScope.vars);
      def.params.forEach((name, i) => {
        if (i < args.length) childVars.set(name, args[i]);
      });
      const childScope: Scope = {
        filePath: callerScope.filePath,
        vars: childVars,
        env: callerScope.env,
        declaredParamNames: def.params,
        locals: callerScope.locals ? new Map(callerScope.locals) : new Map(),
      };
      return this.executeSteps(childScope, def.steps, io);
    }, def.params);
  }

  private mergeStepResult(accOut: string, accErr: string, r: StepResult): StepResult {
    return {
      status: r.status,
      output: accOut + (r.output ?? ""),
      error: accErr + (r.error ?? ""),
      returnValue: r.returnValue,
      // Propagate a `return <call>()` output handle up through the def body so
      // the caller can stream it (`valueFile`) instead of slurping.
      ...(r.valueFile ? { valueFile: r.valueFile } : {}),
    };
  }

  private static readonly INLINE_CAPTURE_RE = /\$\{([A-Za-z_][A-Za-z0-9_.]*\s*\([^}]*\))\}/g;

  /**
   * Interpolate `${var}` refs and inline `${ref(args)}`
   * captures: each capture is executed and replaced with its output, then regular
   * `${var}` interpolation runs. Returns { ok: true, value } or { ok: false, result }.
   *
   * `quoteValue` (only passed for shell-fallthrough lines — `shellQuote`) escapes
   * every substituted value, both `${var}` refs and inline-capture results, so no
   * caller-controlled value can be re-evaluated by `sh -c`. All other value
   * positions omit it and interpolate raw.
   */
  private async interpolateWithCaptures(
    input: string,
    scope: Scope,
    quoteValue?: (s: string) => string,
  ): Promise<{ ok: true; value: string } | { ok: false; result: StepResult }> {
    // Resolve any handle-valued vars referenced in the input before interpolating.
    const handleErr = await this.resolveHandlesInInput(scope, input);
    if (handleErr) return { ok: false, result: handleErr };
    const re = new RegExp(NodeWorkflowRuntime.INLINE_CAPTURE_RE.source, "g");
    if (!re.test(input)) {
      return { ok: true, value: interpolate(input, scope.vars, scope.env, quoteValue) };
    }
    re.lastIndex = 0;
    let result = "";
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      result += input.slice(lastIndex, m.index);
      const { ref, argsRaw } = parseInlineCaptureCall(m[1]);
      const r = await this.executeRunRef(scope, ref, argsRaw);
      if (r.status !== 0) return { ok: false, result: r };
      const captured = this.forceValue(r);
      result += quoteValue ? quoteValue(captured) : captured;
      lastIndex = m.index + m[0].length;
    }
    result += input.slice(lastIndex);
    return { ok: true, value: interpolate(result, scope.vars, scope.env, quoteValue) };
  }

  private async evaluateMatch(
    scope: Scope,
    expr: MatchExprDef,
  ): Promise<{ ok: true; value: string } | { ok: false; result: StepResult }> {
    const resolved = await this.resolveSubjectValue(scope, expr.subject);
    if (!resolved.ok) return { ok: false, result: resolved.result };
    const subject = resolved.value;
    for (const arm of expr.arms) {
      if (patternMatches(arm.pattern, subject)) {
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

        // ref(args) — execute script/workflow and capture return value
        const runM = body.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([^)]*)\)\s*$/);
        if (runM) {
          const result = await this.executeRunRef(scope, runM[1]!, commaArgsToInterpolated(runM[2]!));
          if (result.status !== 0) return { ok: false, result };
          return { ok: true, value: this.forceValue(result) };
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
   * (call/inline_script/match/prompt) and returning its captured
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
      return { ok: true, value: this.forceValue(r), output: "" };
    }
    if (expr.kind === "inline_script") {
      const shebang = expr.lang ? `#!/usr/bin/env ${expr.lang}` : undefined;
      const r = await this.executeInlineScript(scope, expr.body, shebang, argsToRuntimeString(expr.args));
      if (r.status !== 0) return { ok: false, result: r, output: "" };
      return { ok: true, value: this.forceValue(r), output: "" };
    }
    if (expr.kind === "match") {
      const mr = await this.evaluateMatch(scope, expr.match);
      if (!mr.ok) return { ok: false, result: mr.result, output: "" };
      return { ok: true, value: mr.value, output: "" };
    }
    if (expr.kind === "prompt") {
      const inv = await this.resolvePromptInvocation(scope, expr);
      if (!inv.ok) return { ok: false, result: inv.result, output: "" };
      if (inv.returns !== undefined && !promptCaptureName) {
        return {
          ok: false,
          result: { status: 1, output: "", error: 'prompt with "returns" schema must capture to a variable' },
          output: "",
        };
      }
      const r = await this.runPromptStep(inv.promptScope, inv.raw, inv.returns, promptCaptureName, io, inv.useEnv);
      if (!r.ok) return { ok: false, result: r.result, output: r.output };
      // `runPromptStep` writes the capture into its prompt scope; for a named
      // prompt that is the def-site child scope, so copy the binding back.
      if (promptCaptureName && inv.promptScope !== scope) {
        this.copyCaptureAcross(inv.promptScope, scope, promptCaptureName);
      }
      // For captured prompts the value is now in scope; non-capture prompts
      // (no binding) yield empty string.
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

  private async executeSteps(scope: Scope, steps: StepDef[], io?: StepIO): Promise<StepResult> {
    let accOut = "";
    let accErr = "";
    let returnValue: string | undefined;
    /** Handle IDs created by `run async` in this scope (for implicit join at exit). */
    const localHandleIds: string[] = [];
    let asyncCounter = 0;
    for (const step of steps) {
      if (step.type === "trivia") continue;
      if (step.type === "local_decl") {
        // Sequential local binding: visible to later steps in this def body.
        if (!scope.locals) scope.locals = new Map();
        scope.locals.set(localDeclName(step.decl), step.decl);
        continue;
      }
      // Max-step circuit breaker: count every executed step across the whole run
      // (loop iterations and nested/recursive calls share this counter). Once the
      // cap is exceeded, abort so a runaway workflow stops without a manual signal.
      if (this.maxSteps > 0) {
        this.stepsExecuted += 1;
        if (this.stepsExecuted > this.maxSteps) {
          const msg = maxStepsTrippedMessage(this.maxSteps);
          this.emitter.emitLog("LOGERR", msg);
          this.abort();
          return this.mergeStepResult(accOut, accErr, { status: 1, output: "", error: msg });
        }
      }
      if (step.type === "say") {
        let message: string;
        if (step.message.kind === "inline_script") {
          const shebang = step.message.lang ? `#!/usr/bin/env ${step.message.lang}` : undefined;
          const result = await this.executeInlineScript(scope, step.message.body, shebang, argsToRuntimeString(step.message.args));
          if (result.status !== 0) return this.mergeStepResult(accOut, accErr, result);
          message = this.forceValue(result);
        } else if (step.message.kind === "literal") {
          const ir = await this.interpolateWithCaptures(step.message.raw, scope);
          if (!ir.ok) return this.mergeStepResult(accOut, accErr, ir.result);
          message = step.level === "fail" || step.level === "logerr" || step.level === "logwarn"
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
        const eventLevel =
          step.level === "log" ? "LOG"
          : step.level === "logwarn" ? "LOGWARN"
          : "LOGERR";
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
        // `return <call>()` / `return <inline_script>()` propagates the callee's
        // output handle: the def's return value is the callee's bytes on disk
        // (`valueFile`), NOT slurped here. The caller slurps only at its own
        // force site — so `stdin wrap() -> sink()` streams the file while
        // `const y = wrap()` reads it. Printing the entry def's return streams
        // the file to the user rather than pulling it through V8.
        if (value.kind === "call" || value.kind === "inline_script") {
          const r = value.kind === "call"
            ? await this.executeRunRef(scope, value.callee.value, argsToRuntimeString(value.args))
            : await this.executeInlineScript(
                scope,
                value.body,
                value.lang ? `#!/usr/bin/env ${value.lang}` : undefined,
                argsToRuntimeString(value.args),
              );
          if (r.status !== 0) return this.mergeStepResult(accOut, accErr, r);
          return this.mergeStepResult(accOut, accErr, {
            status: 0,
            output: "",
            error: "",
            ...(r.returnValue !== undefined ? { returnValue: r.returnValue } : {}),
            ...(r.valueFile ? { valueFile: r.valueFile } : {}),
          });
        }
        const r = await this.evaluateExpr(scope, value, undefined, io);
        accOut += r.output;
        if (!r.ok) return this.mergeStepResult(accOut, accErr, r.result);
        returnValue = r.value;
        return this.mergeStepResult(accOut, accErr, { status: 0, output: "", error: "", returnValue });
      }
      if (step.type === "send") {
        const ctx = this.defCtxStack[this.defCtxStack.length - 1];
        if (!ctx) {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: SEND_OUTSIDE_DEF_CONTEXT_ERROR,
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
          payload = this.forceValue(r);
        } else {
          return this.mergeStepResult(accOut, accErr, {
            status: 1,
            output: "",
            error: `unsupported send value kind: ${sendValue.kind}`,
          });
        }
        this.inboxSeq += 1;
        const seqPadded = String(this.inboxSeq).padStart(3, "0");
        const senderName = ctx.defName;
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
        for (let i = this.defCtxStack.length - 1; i >= 0; i -= 1) {
          if (this.defCtxStack[i]!.routes.has(channelKey)) {
            targetCtx = this.defCtxStack[i]!;
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
                const rr = await this.runRecoverBody(scope, recover, lastResult);
                if (rr.status !== 0 || this.stepReturned(rr)) return rr;
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
              const rr = await this.runRecoverBody(scope, recover, result);
              if (rr.status !== 0) return rr;
              if (this.stepReturned(rr)) return { ...rr, recoverReturn: true };
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
          // Streaming pipeline (`stdin gen() -> upper() -> count()`): stages run
          // concurrently through bounded buffers and overlap. `recover` is
          // rejected at parse time, so only capture and a one-shot `catch` apply.
          if (step.stdin && this.isPipeline(step)) {
            const runResult = await this.executePipeline(scope, step);
            if (runResult.status === 0) {
              if (step.captureName) scope.vars.set(step.captureName, this.forceValue(runResult));
            } else if (step.catch) {
              const rr = await this.runRecoverBody(scope, step.catch, runResult);
              if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
            } else {
              return this.mergeStepResult(accOut, accErr, runResult);
            }
            continue;
          }
          // Plain `stdin <value> -> script()` connect: resolve the value / bound
          // handle once, before any recover retries — the same source (bytes, or
          // an on-disk handle) is piped to the child on every attempt.
          let stdinSource: StdinSource | undefined;
          if (step.stdin) {
            const sr = await this.resolveStdin(scope, step.stdin);
            if (!sr.ok) {
              if (step.catch) {
                const rr = await this.runRecoverBody(scope, step.catch, sr.result);
                if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
                continue;
              }
              return this.mergeStepResult(accOut, accErr, sr.result);
            }
            stdinSource = sr.source;
          }
          if (step.recover) {
            const limit = this.resolveRecoverLimit(scope.filePath);
            const ref = body.callee.value;
            const argsRaw = argsToRuntimeString(body.args);
            let lastResult = await this.executeRunRef(scope, ref, argsRaw, stdinSource);
            let attempt = 1;
            while (lastResult.status !== 0 && attempt <= limit) {
              const rr = await this.runRecoverBody(scope, step.recover, lastResult);
              if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
              lastResult = await this.executeRunRef(scope, ref, argsRaw, stdinSource);
              attempt += 1;
            }
            if (lastResult.status === 0) {
              if (step.captureName) {
                scope.vars.set(step.captureName, this.forceValue(lastResult));
              }
            } else {
              return this.mergeStepResult(accOut, accErr, lastResult);
            }
            continue;
          }
          const runResult = await this.executeRunRef(
            scope, body.callee.value, argsToRuntimeString(body.args), stdinSource,
          );
          if (runResult.status === 0) {
            if (step.captureName) {
              scope.vars.set(step.captureName, this.forceValue(runResult));
            }
          } else if (step.catch) {
            const rr = await this.runRecoverBody(scope, step.catch, runResult);
            if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
          } else {
            return this.mergeStepResult(accOut, accErr, runResult);
          }
          continue;
        }
        if (body.kind === "inline_script") {
          const shebang = body.lang ? `#!/usr/bin/env ${body.lang}` : undefined;
          const argsRaw = argsToRuntimeString(body.args);
          // Streaming pipeline whose final stage is an inline script; stages run
          // concurrently through bounded buffers. `recover` is rejected at parse.
          if (step.stdin && this.isPipeline(step)) {
            const runResult = await this.executePipeline(scope, step);
            if (runResult.status === 0) {
              if (step.captureName) scope.vars.set(step.captureName, this.forceValue(runResult));
            } else if (step.catch) {
              const rr = await this.runRecoverBody(scope, step.catch, runResult);
              if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
            } else {
              return this.mergeStepResult(accOut, accErr, runResult);
            }
            continue;
          }
          let stdinSource: StdinSource | undefined;
          if (step.stdin) {
            const sr = await this.resolveStdin(scope, step.stdin);
            if (!sr.ok) {
              if (step.catch) {
                const rr = await this.runRecoverBody(scope, step.catch, sr.result);
                if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
                continue;
              }
              return this.mergeStepResult(accOut, accErr, sr.result);
            }
            stdinSource = sr.source;
          }
          const runOnce = (): Promise<StepResult> =>
            this.executeInlineScript(scope, body.body, shebang, argsRaw, stdinSource);
          if (step.recover) {
            const limit = this.resolveRecoverLimit(scope.filePath);
            let lastResult = await runOnce();
            let attempt = 1;
            while (lastResult.status !== 0 && attempt <= limit) {
              const rr = await this.runRecoverBody(scope, step.recover, lastResult);
              if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
              lastResult = await runOnce();
              attempt += 1;
            }
            if (lastResult.status === 0) {
              if (step.captureName) {
                scope.vars.set(step.captureName, this.forceValue(lastResult));
              }
            } else {
              return this.mergeStepResult(accOut, accErr, lastResult);
            }
            continue;
          }
          const result = await runOnce();
          if (result.status === 0) {
            if (step.captureName) {
              scope.vars.set(step.captureName, this.forceValue(result));
            }
          } else if (step.catch) {
            const rr = await this.runRecoverBody(scope, step.catch, result);
            if (rr.status !== 0 || this.stepReturned(rr)) return this.mergeStepResult(accOut, accErr, rr);
          } else {
            return this.mergeStepResult(accOut, accErr, result);
          }
          continue;
        }
        if (body.kind === "prompt") {
          const inv = await this.resolvePromptInvocation(scope, body);
          if (!inv.ok) return this.mergeStepResult(accOut, accErr, inv.result);
          if (inv.returns !== undefined && !step.captureName) {
            return this.mergeStepResult(accOut, accErr, {
              status: 1,
              output: "",
              error: 'prompt with "returns" schema must capture to a variable',
            });
          }
          const r = await this.runPromptStep(inv.promptScope, inv.raw, inv.returns, step.captureName, io, inv.useEnv);
          accOut += r.output;
          if (!r.ok) return this.mergeStepResult(accOut, accErr, r.result);
          // Named-prompt captures bind into the current scope, not the def-site child scope.
          if (step.captureName && inv.promptScope !== scope) {
            this.copyCaptureAcross(inv.promptScope, scope, step.captureName);
          }
          continue;
        }
        if (body.kind === "match") {
          const matchResult = await this.evaluateMatch(scope, body.match);
          if (!matchResult.ok) return this.mergeStepResult(accOut, accErr, matchResult.result);
          if (step.captureName) scope.vars.set(step.captureName, matchResult.value);
          continue;
        }
        if (body.kind === "shell") {
          // Shell-fallthrough lines are the one `sh -c` interpolation sink, so
          // every interpolated value is shell-quoted (H-1): a caller-controlled
          // param/capture/iterator/channel value can never inject command
          // substitution or a metacharacter breakout.
          const cmdIr = await this.interpolateWithCaptures(body.command, scope, shellQuote);
          if (!cmdIr.ok) return this.mergeStepResult(accOut, accErr, cmdIr.result);
          const stepName = `sh_line_${body.loc.line}`;
          const result = await this.executeManagedStep(
            "script",
            stepName,
            [],
            (io) => this.executeShLine(scope, cmdIr.value, io),
          );
          if (step.captureName && result.status === 0) {
            scope.vars.set(step.captureName, this.forceValue(result));
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
          const bodyResult = await this.executeSteps(blockChildScope(scope), branch, io);
          if (bodyResult.status !== 0 || this.stepReturned(bodyResult)) {
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
          // Each iteration is its own block scope: the iterator and any nested
          // decl in the body are visible only inside the body, not after the loop.
          const iterScope = blockChildScope(scope);
          iterScope.vars.set(step.iterVar, line);
          const bodyResult = await this.executeSteps(iterScope, step.body, io);
          if (bodyResult.status !== 0 || this.stepReturned(bodyResult)) {
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
    const resolved = resolveDefRef(this.graph, scope.filePath, { value: target, loc: { line: 1, col: 1 } });
    const params = resolved?.def.params ?? [];
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
        const resolved = resolveDefRef(this.graph, scope.filePath, { value: target, loc: { line: 1, col: 1 } });
        const n = resolved?.def.params.length ?? 0;
        const inboxArgs = [msg.content, msg.channel, msg.sender].slice(0, n);
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
        resolved.push(this.forceValue(result));
        continue;
      }
      const result = await this.executeRunRef(scope, token.ref, token.argsRaw);
      if (result.status !== 0) {
        return result;
      }
      resolved.push(this.forceValue(result));
    }
    return resolved;
  }

  /**
   * Resolve a plain `stdin <value> -> script()` connect operand to the bytes /
   * on-disk handle fed to the child. The operand is always a `literal` (the
   * parser normalizes bare / interpolation forms to a quoted literal); a call /
   * inline-script producer is a pipeline and streams live through
   * `executePipeline` instead, never here. A bare `"${ident}"` naming a bound
   * output handle (a `recover` / `catch` failure) streams that handle's file;
   * any other value interpolates and strips the outer quotes like a `const`.
   */
  private async resolveStdin(
    scope: Scope,
    stdinExpr: Expr,
  ): Promise<{ ok: true; source: StdinSource } | { ok: false; result: StepResult }> {
    const raw = stdinExpr.kind === "literal" ? stdinExpr.raw : "";
    // A bare `"${ident}"` naming an output-handle var (a `recover`/`catch`
    // binding) streams that handle's file — `stdin failure -> sink()` never
    // slurps the failed step's stdout into memory.
    const bare = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
    if (bare) {
      const bound = scope.vars.get(bare[1]!);
      if (bound && this.isHandle(bound)) {
        const r = await this.resolveHandleResult(bound);
        if (r.status !== 0) return { ok: false, result: r };
        return { ok: true, source: this.handleStdinSource(r) };
      }
    }
    const ir = await this.interpolateWithCaptures(raw, scope);
    if (!ir.ok) return { ok: false, result: ir.result };
    return { ok: true, source: { kind: "bytes", bytes: stripOuterQuotes(ir.value) } };
  }

  /**
   * Run one live pipeline stage (a script call or inline script) with `source`
   * on its stdin. `onSpawn` fires the moment the child is spawned so the caller
   * can tee this stage's live stdout into the next stage's link. Each stage is
   * its own managed step in the progress tree.
   */
  private runPipelineStage(
    scope: Scope,
    stage: Expr,
    source: StdinSource | undefined,
    onSpawn?: (stdout: Readable | undefined) => void,
    endGate?: Promise<unknown>,
  ): Promise<StepResult> {
    if (stage.kind === "inline_script") {
      const shebang = stage.lang ? `#!/usr/bin/env ${stage.lang}` : undefined;
      return this.executeInlineScript(scope, stage.body, shebang, argsToRuntimeString(stage.args), source, onSpawn, endGate);
    }
    if (stage.kind === "call") {
      return this.executeRunRef(scope, stage.callee.value, argsToRuntimeString(stage.args), source, onSpawn, endGate);
    }
    return Promise.resolve({ status: 1, output: "", error: "internal: invalid stdin pipeline stage" });
  }

  /**
   * True when the exec step's `stdin` clause is a streaming pipeline (producer
   * is a call, or there is at least one intermediate stage) rather than a plain
   * `stdin <value> -> script()` connect. Mirrors the parser's pipeline test.
   */
  private isPipeline(step: Extract<StepDef, { type: "exec" }>): boolean {
    const p = step.stdin;
    if (!p) return false;
    if ((step.stages?.length ?? 0) > 0) return true;
    return p.kind === "call" || p.kind === "inline_script";
  }

  /**
   * True when a producer call ref resolves to a `def`. A def is not a single
   * subprocess, so a def producer runs to completion and feeds its on-disk
   * output handle into the live chain; a script producer streams live.
   */
  private producerIsDef(scope: Scope, ref: string): boolean {
    if (!ref.includes(".")) {
      const local = scope.locals?.get(ref);
      if (local?.kind === "def") return true;
      if (local?.kind === "script") return false;
    }
    return resolveDefRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } }) !== null;
  }

  /**
   * Execute a streaming stdin pipeline. Every script/inline stage runs
   * concurrently: each stage tees its stdout (writes `.out` and pipes into the
   * next stdin) so producer and consumer overlap, the audit log is complete, and
   * peak RSS stays independent of the payload. A def producer runs to completion
   * first (its on-disk handle streams in); a value producer resolves to bytes.
   * The pipeline result is the first non-zero stage, or the final stage on
   * success (which feeds `const` capture / `return`). `catch` is applied by the
   * caller; `recover` is rejected at parse time.
   */
  private async executePipeline(
    scope: Scope,
    step: Extract<StepDef, { type: "exec" }>,
  ): Promise<StepResult> {
    const producer = step.stdin!;
    const liveStages: Expr[] = [];
    let upstream: StdinSource | undefined;
    if (producer.kind === "call" && this.producerIsDef(scope, producer.callee.value)) {
      const r = await this.executeRunRef(scope, producer.callee.value, argsToRuntimeString(producer.args));
      if (r.status !== 0) return r;
      upstream = this.handleStdinSource(r);
    } else if (producer.kind === "call" || producer.kind === "inline_script") {
      liveStages.push(producer);
    } else {
      const sr = await this.resolveStdin(scope, producer);
      if (!sr.ok) return sr.result;
      upstream = sr.source;
    }
    for (const stage of step.stages ?? []) liveStages.push(stage);
    liveStages.push(step.body);

    // One promise per adjacent pair, resolved with the upstream stage's live
    // stdout the moment it spawns. The downstream stage awaits it and pipes
    // that stdout into its stdin (tee: the upstream also writes `.out`), so all
    // stages still spawn back-to-back and run concurrently. Each promise is
    // also resolved with `undefined` when its stage settles, so a stage that
    // never spawns (an arg-resolution failure) can't hang the downstream — it
    // just reads EOF.
    const boundaries = liveStages.length - 1;
    const stdoutResolvers: Array<(s: Readable | undefined) => void> = [];
    const upstreamStdout: Array<Promise<Readable | undefined>> = Array.from(
      { length: boundaries },
      (_unused, j) => new Promise<Readable | undefined>((res) => { stdoutResolvers[j] = res; }),
    );
    // Built in order so stage `i` can gate its STEP_END emit on stage `i - 1`'s
    // completion. The stages still run fully concurrently — each stage's process
    // spawns and streams inside `runPipelineStage`; only the progress-tree
    // STEP_END emit waits on the upstream stage, so completions render in pipeline
    // order regardless of how the childrens' `close` events race across platforms.
    const running: Array<Promise<StepResult>> = [];
    for (let i = 0; i < liveStages.length; i++) {
      const stage = liveStages[i]!;
      const hasDownstream = i < boundaries;
      const endGate = i > 0 ? running[i - 1] : undefined;
      running.push((async () => {
        let source: StdinSource | undefined;
        if (i === 0) {
          source = upstream;
        } else {
          const prev = await upstreamStdout[i - 1]!;
          source = prev ? { kind: "fd", stream: prev } : undefined;
        }
        // A non-terminal stage hands its stdout to the next stage the instant it
        // spawns; the terminal stage gets no onSpawn, so it captures normally.
        const onSpawn = hasDownstream
          ? (stdout: Readable | undefined): void => stdoutResolvers[i]!(stdout)
          : undefined;
        try {
          return await this.runPipelineStage(scope, stage, source, onSpawn, endGate);
        } finally {
          if (hasDownstream) stdoutResolvers[i]!(undefined);
        }
      })());
    }

    const settled = await Promise.all(running);
    for (const r of settled) {
      if (r.status !== 0) return r; // first non-zero stage is the pipeline failure
    }
    return settled[settled.length - 1]!;
  }

  private async executeRunRef(
    scope: Scope,
    ref: string,
    argsRaw: string | string[],
    stdin?: StdinSource,
    onSpawn?: (stdout: Readable | undefined) => void,
    endGate?: Promise<unknown>,
  ): Promise<StepResult> {
    const resolvedArgs = await this.resolveArgsRaw(scope, argsRaw);
    if (!Array.isArray(resolvedArgs)) return resolvedArgs;
    const args = resolvedArgs;
    // Nested (def-local) declarations shadow module symbols and win first.
    if (!ref.includes(".")) {
      const local = scope.locals?.get(ref);
      if (local?.kind === "def") {
        return this.executeLocalDef(scope, local.def, args);
      }
      if (local?.kind === "script") {
        const sc = local.script;
        // Sterile subprocess env + this script's `use` grant (same as a module
        // script). Enclosing bindings are NOT exported; args arrive as argv.
        const scriptEnv = this.buildScriptSpawnEnv(scope.env, sc.use);
        const fileName = nestedScriptName(sc.name, sc.body, sc.lang, sc.use);
        return this.executeManagedStep(
          "script",
          ref,
          args,
          async (io) => this.executeScript(scope.filePath, fileName, args, scriptEnv, io, stdin, onSpawn),
          undefined,
          endGate,
        );
      }
      // A local `prompt` reached via `run` is a validation error; fall through
      // to module resolution, which reports "Unknown run target".
    }
    const resolvedDef = resolveDefRef(this.graph, scope.filePath, { value: ref, loc: { line: 1, col: 1 } });
    if (resolvedDef) {
      const mk = this.mockKey(resolvedDef.filePath, resolvedDef.def.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep(
          "def",
          ref,
          args,
          async () => this.dispatchMockBody(ref, mockBody, args),
          resolvedDef.def.params,
        );
      }
      return this.executeDef(resolvedDef.filePath, resolvedDef.def.name, scope, args, true);
    }
    const resolvedScript = resolveScriptRef(this.graph, scope.filePath, ref);
    if (resolvedScript) {
      const mk = this.mockKey(resolvedScript.filePath, resolvedScript.script.name);
      const mockBody = this.mockBodies.get(mk);
      if (mockBody !== undefined) {
        return this.executeManagedStep("script", ref, args, async () => this.dispatchMockBody(ref, mockBody, args));
      }
      // Sterile script env: base process mechanics + runtime contract keys +
      // this script's `use` keys intersected with the `--env` grant.
      const scriptEnv = this.buildScriptSpawnEnv(scope.env, resolvedScript.script.use);
      return this.executeManagedStep(
        "script",
        ref,
        args,
        async (io) =>
          this.executeScript(resolvedScript.filePath, resolvedScript.script.name, args, scriptEnv, io, stdin, onSpawn),
        undefined,
        endGate,
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
  /**
   * Resolve a prompt expression to the concrete body/returns/env to run. For an
   * anonymous prompt this is the in-scope raw + returns. For a named-prompt
   * invocation (`prompt foo(args)`) it resolves the module-level `PromptDef`,
   * binds parameters to the resolved argument values in a fresh definition-site
   * scope, and computes the `use` env (granted host keys) injected on top of the
   * scrubbed agent env.
   */
  private async resolvePromptInvocation(
    scope: Scope,
    expr: Extract<Expr, { kind: "prompt" }>,
  ): Promise<
    | { ok: true; promptScope: Scope; raw: string; returns: string | undefined; useEnv?: NodeJS.ProcessEnv }
    | { ok: false; result: StepResult }
  > {
    if (expr.name === undefined) {
      return { ok: true, promptScope: scope, raw: expr.raw, returns: expr.returns };
    }
    // Nested (def-local) named prompt: its body interpolates the enclosing scope
    // (params/consts) plus its own params; `use` is its own.
    if (!expr.name.includes(".")) {
      const local = scope.locals?.get(expr.name);
      if (local?.kind === "prompt") {
        const prompt = local.prompt;
        const argValues = await this.resolveArgsRaw(scope, argsToRuntimeString(expr.args));
        if (!Array.isArray(argValues)) return { ok: false, result: argValues };
        const childVars = new Map(scope.vars);
        prompt.params.forEach((p, i) => childVars.set(p, argValues[i] ?? ""));
        const promptScope: Scope = { ...scope, vars: childVars };
        return {
          ok: true,
          promptScope,
          raw: prompt.raw,
          returns: prompt.returns,
          useEnv: this.buildPromptUseEnv(prompt.use),
        };
      }
    }
    const resolved = resolvePromptRef(this.graph, scope.filePath, expr.name);
    if (!resolved) {
      return { ok: false, result: { status: 1, output: "", error: `Unknown prompt: ${expr.name}` } };
    }
    const argValues = await this.resolveArgsRaw(scope, argsToRuntimeString(expr.args));
    if (!Array.isArray(argValues)) return { ok: false, result: argValues };
    // Definition-site scope: only the prompt's params + its module `const`s are
    // visible in the body (caller locals are not), mirroring a def call.
    const childVars = this.newScopeVars(resolved.filePath, undefined, scope.env);
    resolved.prompt.params.forEach((p, i) => childVars.set(p, argValues[i] ?? ""));
    const promptScope: Scope = { ...scope, filePath: resolved.filePath, vars: childVars };
    return {
      ok: true,
      promptScope,
      raw: resolved.prompt.raw,
      returns: resolved.prompt.returns,
      useEnv: this.buildPromptUseEnv(resolved.prompt.use),
    };
  }

  /**
   * Copy a prompt capture (and its typed `${name}_field` exports) from a
   * def-site child scope back into the caller scope so downstream steps resolve
   * the binding.
   */
  private copyCaptureAcross(from: Scope, to: Scope, captureName: string): void {
    const value = from.vars.get(captureName);
    if (value !== undefined) to.vars.set(captureName, value);
    const prefix = `${captureName}_`;
    for (const [k, v] of from.vars) {
      if (k.startsWith(prefix)) to.vars.set(k, v);
    }
  }

  /**
   * Host keys a named prompt's `use` clause requests, intersected with the
   * operator's `--env` grant, with values from the off-process grant map
   * (`grantValues`). These are injected into the agent subprocess on top of
   * `scrubPromptEnv`.
   */
  private buildPromptUseEnv(useKeys: readonly string[] | undefined): NodeJS.ProcessEnv | undefined {
    if (!useKeys || useKeys.length === 0) return undefined;
    const out: NodeJS.ProcessEnv = {};
    for (const key of useKeys) {
      if (!this.envGrantKeys.has(key)) continue;
      const value = this.grantValues[key];
      if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * `prompt x` / `prompt ${x}` (identifier / bare-ref body, raw `"${ident}"`)
   * naming a bound output handle keeps the handle: resolve it to its on-disk
   * capture so the transport streams the bytes instead of slurping a
   * (possibly multi-megabyte) file into a JS string. Mirrors `stdin <handle> ->`.
   * Returns `null` when the body is not a bare handle ref (a plain string, an
   * interpolated `"… ${x} …"`, or a non-handle var) so the caller interpolates
   * normally — that path is a slurp by design. An eager (in-memory) handle value
   * returns as bytes; the file case returns a path for streaming.
   */
  private async resolvePromptHandleSource(
    scope: Scope,
    raw: string,
  ): Promise<
    | { ok: true; source: null }
    | { ok: true; source: { kind: "bytes"; bytes: string } }
    | { ok: true; source: { kind: "file"; path: string } }
    | { ok: false; result: StepResult }
  > {
    const bare = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
    if (!bare) return { ok: true, source: null };
    const bound = scope.vars.get(bare[1]!);
    if (!bound || !this.isHandle(bound)) return { ok: true, source: null };
    const r = await this.resolveHandleResult(bound);
    if (r.status !== 0) return { ok: false, result: r };
    if (r.returnValue !== undefined) return { ok: true, source: { kind: "bytes", bytes: r.returnValue } };
    if (r.valueFile) return { ok: true, source: { kind: "file", path: r.valueFile } };
    return { ok: true, source: { kind: "bytes", bytes: (r.output ?? "").trim() } };
  }

  /** First up-to-`limit` bytes of a file as a preview string (bounded read, never a slurp). */
  private readFilePreview(path: string, limit: number): string {
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(limit);
        const n = readSync(fd, buf, 0, limit, 0);
        return buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  private async runPromptStep(
    scope: Scope,
    raw: string,
    returns: string | undefined,
    captureName: string | undefined,
    io: StepIO | undefined,
    useEnv?: NodeJS.ProcessEnv,
  ): Promise<{ ok: true; output: string } | { ok: false; result: StepResult; output: string }> {
    const promptConfig = resolvePromptConfig(scope.env, this.resolveConfigAgentModel(scope, scope.filePath));
    const backend = promptConfig.backend || "cursor";
    const stepName = resolvePromptStepName(promptConfig);
    const modelRes = resolveModel(promptConfig);
    const handleRes = await this.resolvePromptHandleSource(scope, raw);
    if (!handleRes.ok) return { ok: false, result: handleRes.result, output: "" };
    // A file-sourced handle streams into the backend and is never slurped here —
    // except for the cursor-agent backend, which delivers the body on argv and
    // so must materialize it like any argv value (interpolated below). An eager
    // (in-memory) handle value and every other body interpolate to a string.
    const fileSource =
      handleRes.source?.kind === "file" && promptBodyOffArgv(promptConfig) ? handleRes.source : undefined;
    let promptText: string;
    if (handleRes.source?.kind === "bytes") {
      promptText = handleRes.source.bytes;
    } else if (fileSource) {
      promptText = "";
    } else {
      const promptIr = await this.interpolateWithCaptures(raw, scope);
      if (!promptIr.ok) return { ok: false, result: promptIr.result, output: "" };
      promptText = promptIr.value;
    }
    let schemaFields: PromptSchemaField[] | undefined;
    let schemaSuffix = "";
    if (returns !== undefined) {
      schemaFields = parsePromptSchema(returns);
      const schemaObject = Object.fromEntries(schemaFields.map((f) => [f.name, f.type]));
      schemaSuffix =
        "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
        JSON.stringify(schemaObject);
      // A file source appends the schema after the streamed bytes (see
      // `promptSource.suffix`); every other body appends to the string here.
      if (!fileSource) promptText += schemaSuffix;
    }
    const promptSource: PromptSource | undefined = fileSource
      ? { open: () => createReadStream(fileSource.path), suffix: schemaSuffix }
      : undefined;
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
      const stepModel = modelForStepEvent(modelRes);
      const promptStep = this.emitter.emitPromptStepStart(stepName, stepModel, scope.vars, raw);
      this.emitter.emitPromptEvent("PROMPT_START", {
        backend,
        model: modelRes.model || undefined,
        model_reason: modelRes.reason,
        preview: fileSource ? this.readFilePreview(fileSource.path, 120) : promptText.slice(0, 120),
      });
      const out = new PassThrough();
      const chunks: string[] = [];
      const err = new PassThrough();
      const errChunks: string[] = [];
      const idleWarn = createStepIdleOutputWarn(this.emitter, "prompt", stepName, scope.env);
      try {
        out.on("data", (d) => {
          const chunk = String(d);
          chunks.push(chunk);
          appendFileSync(promptStep.outFile, chunk);
          io?.appendOut(chunk);
          if (chunk.length > 0) idleWarn?.bump();
        });
        err.on("data", (d) => {
          const chunk = String(d);
          errChunks.push(chunk);
          io?.appendErr(chunk);
          if (chunk.length > 0) idleWarn?.bump();
        });
        const result = await executePrompt(promptText, promptConfig, out, scope.env, err, useEnv, promptSource);
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
      } finally {
        idleWarn?.stop();
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

  /**
   * Merge the failed step's stdout then stderr into one on-disk capture and
   * return its path — the byte source for a `recover` / `catch` handle. The
   * handle is a single stream (stdout followed by stderr), so a force site
   * slurps the merged contents and `stdin failure -> script()` streams them.
   * The two captures are concatenated on disk in bounded chunks and never
   * slurped into one JS string, so a multi-megabyte failure stays out of the
   * heap. The `.merged` name is deliberately not `.out`, so the recovery body
   * never binds a `.jaiph/runs/…/NNNNNN-*.out` path.
   */
  private writeRecoverMerge(stdoutFile: string | undefined, errFile: string | undefined): string {
    this.recoverMergeCounter += 1;
    const seq = String(this.recoverMergeCounter).padStart(6, "0");
    const mergedFile = join(this.runDir, `${seq}-recover.merged`);
    const dest = openSync(mergedFile, "w");
    try {
      this.copyFileBytes(dest, stdoutFile);
      this.copyFileBytes(dest, errFile);
    } finally {
      closeSync(dest);
    }
    return mergedFile;
  }

  /** Append a source file's bytes into an open fd in bounded chunks (never a slurp). */
  private copyFileBytes(destFd: number, srcPath: string | undefined): void {
    if (!srcPath) return;
    let src: number;
    try {
      src = openSync(srcPath, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(64 * 1024);
      let n = readSync(src, buf, 0, buf.length, null);
      while (n > 0) {
        writeSync(destFd, buf, 0, n);
        n = readSync(src, buf, 0, buf.length, null);
      }
    } finally {
      closeSync(src);
    }
  }

  /** Run a recover/catch body with `failure` bound to the failed step's payload. */
  private async runRecoverBody(
    scope: Scope,
    catchDef: { bindings: { failure: string } } & (
      | { single: StepDef }
      | { block: StepDef[] }
    ),
    failed: StepResult,
  ): Promise<StepResult> {
    const recoverSteps = "single" in catchDef ? [catchDef.single] : catchDef.block;
    // A recover / catch body is its own block scope: copy `locals` (as well as
    // `vars`) so a nested decl inside the body does not leak past it.
    const bodyScope = blockChildScope(scope);
    // Bind the failed step as an OUTPUT HANDLE, not a run-dir path: a status-0
    // handle whose `valueFile` is the failed step's stdout THEN stderr merged
    // into one capture. So `${failure}` / a bare-arg / `if failure` slurps the
    // merged CONTENTS, and `stdin failure -> sink()` streams that file — the
    // author never sees a `.jaiph/runs/…/NNNNNN-*.out` path. A Unix failure that
    // writes only to stderr still yields a non-empty handle without any `2>&1`.
    // The stdout bytes are the failed step's stdout: a leaf script's own
    // capture, or — when a def failed because an inner call failed — the inner
    // stdout propagated up as `valueFile`. The stderr bytes are the failed
    // step's accumulated `.err` capture.
    const stdoutFile = failed.valueFile ?? failed.outFile;
    const mergedFile = this.writeRecoverMerge(stdoutFile, failed.errFile);
    const handleId = this.createResolvedHandle(catchDef.bindings.failure, {
      status: 0,
      output: "",
      error: "",
      valueFile: mergedFile,
    });
    bodyScope.vars.set(catchDef.bindings.failure, handleId);
    return this.executeSteps(bodyScope, recoverSteps);
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
    stdin?: StdinSource,
    // Invoked synchronously the moment the child is spawned, before any await.
    // A pipeline uses it to receive this stage's teed stdout (PassThrough) and
    // pipe it into the next stdin, so all stages spawn in one tick and overlap.
    onSpawn?: (stdout: Readable | undefined) => void,
  ): Promise<StepResult> {
    return new Promise((resolve) => {
      // Output handle: the child's stdout is streamed straight to disk through
      // `io.appendOut` (the step's `.out` capture) and is NEVER accumulated into
      // a JS string here. A discarded statement call therefore holds no bytes in
      // memory (the 64 MiB no-slurp pin); a force site reads the capture back
      // via `forceValue`. `streamed: true` tells `executeManagedStep` the files
      // are already written. stderr stays small and is kept for diagnostics.
      let error = "";
      const killSignal = io?.killSignal;
      // Single-settle guard shared by the normal close/error paths and the
      // idle-output kill watchdog, so the step resolves exactly once.
      let settled = false;
      const settle = (result: StepResult): void => {
        if (settled) return;
        settled = true;
        killSignal?.removeEventListener("abort", onIdleKill);
        resolve(result);
      };
      // A synchronous throw from `spawn` (notably `E2BIG` when argv + env exceed
      // the OS `ARG_MAX`) must fail the step exactly like the async `'error'`
      // event — never reject this Promise, or the run vanishes with no
      // STEP_END/RUN_END. Settle a status-1 failure with the same diagnostic.
      // stdin[0]: a `bytes`/`file`/`fd` source is fed as `pipe`. An `fd` source
      // (the previous pipeline stage's live stdout) is relayed below through a
      // backpressured `.pipe()` so this stage and the previous `.out` capture
      // can both read it (tee). Every other step keeps stdin `ignore` so the
      // child never blocks on a closed tty.
      const stdinMode = stdin !== undefined ? "pipe" : "ignore";
      let child: ReturnType<typeof _scriptSpawn.spawn>;
      try {
        child = _scriptSpawn.spawn(command, args, { cwd, env, stdio: [stdinMode, "pipe", "pipe"] });
      } catch (err) {
        const msg = spawnFailureText(err, command, args, env, interpreter);
        error += msg;
        io?.appendErr(msg);
        // The child never spawned, so drain the upstream stage's stdout (an `fd`
        // source) here or it would hang, un-read, and the upstream never reaches
        // `close`.
        if (stdin?.kind === "fd") {
          try {
            stdin.stream.destroy();
          } catch {
            // best-effort: upstream may have already gone away
          }
        }
        settle({ status: 1, output: "", error, streamed: true });
        return;
      }
      // Tee stdout: write `.out` and, when this is a non-terminal pipeline
      // stage, copy the same chunks into a PassThrough the next stage pipes
      // into its stdin. A PassThrough buffers until that pipe attaches, so
      // early chunks are not lost. Pause the child if the tee fills.
      child.stderr?.setEncoding("utf8");
      const handoff = onSpawn && child.stdout ? new PassThrough() : undefined;
      child.stdout?.on("data", (chunk: Buffer) => {
        io?.appendOut(chunk);
        if (handoff && !handoff.write(chunk)) child.stdout?.pause();
      });
      if (handoff) {
        handoff.on("drain", () => child.stdout?.resume());
        child.stdout?.on("end", () => handoff.end());
        child.stdout?.on("error", () => handoff.destroy());
        onSpawn?.(handoff);
      } else if (onSpawn) {
        onSpawn(undefined);
      }
      // Idle-output kill watchdog: when the step's kill signal fires the leaf
      // has produced no output for JAIPH_STEP_IDLE_KILL_SEC. Terminate the child
      // (SIGTERM → SIGKILL) and settle a failure immediately. We do NOT wait for
      // `close`: a descendant that outlived the child while holding the stdout
      // write end (the classic hung-subtree case) would otherwise keep the pipe
      // open — and the run stuck — indefinitely. Destroying the pipes here
      // releases Node's handles so the runtime moves on regardless (mirrors the
      // prompt watchdog settle in prompt.ts).
      let idleKilled = false;
      function onIdleKill(): void {
        if (idleKilled || settled) return;
        idleKilled = true;
        if (typeof child.pid === "number") killProcessTreeEscalating(child.pid);
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          // best-effort cleanup
        }
        const msg =
          "step terminated: no new output within the idle-output kill timeout (JAIPH_STEP_IDLE_KILL_SEC)";
        settle({ status: 1, output: "", error: error ? `${error}\n${msg}` : msg, streamed: true });
      }
      if (killSignal) {
        if (killSignal.aborted) onIdleKill();
        else killSignal.addEventListener("abort", onIdleKill, { once: true });
      }
      // stderr stays utf8 — it is small and accumulated for diagnostics.
      // stdout stays undecoded (Buffer chunks) so the `.out` tee never allocates
      // a matching JS string.
      child.stderr?.on("data", (chunk: string) => {
        error += chunk;
        io?.appendErr(chunk);
      });
      child.on("error", (err) => {
        const msg = spawnFailureText(err, command, args, env, interpreter);
        error += msg;
        io?.appendErr(msg);
        settle({ status: 1, output: "", error, streamed: true });
      });
      child.on("close", (code) => {
        const status = typeof code === "number" ? code : 1;
        // No `returnValue`: a successful call's value is its stdout on disk, read
        // back by `forceValue` only at a force site. `output` stays empty.
        settle({ status, output: "", error, streamed: true });
      });
      // Feed the `stdin <value> -> script()` source to the child, then close the
      // stream. Attached last, after the stdout/stderr readers, so a payload
      // larger than the pipe buffer (megabytes) never deadlocks a child that
      // echoes its input. A `file` source is piped as a read stream — the
      // producer's bytes are never slurped into a JS string (the stdin no-slurp
      // pin). An `fd` source (live previous-stage stdout) is relayed through a
      // backpressured `.pipe()` so this child and the previous `.out` capture
      // both see every chunk (tee). An EPIPE on a child that exits early is
      // ignored: the exit code already settled the step.
      if (stdin !== undefined && child.stdin) {
        const childStdin = child.stdin;
        childStdin.on("error", () => {});
        if (stdin.kind === "bytes") {
          childStdin.end(stdin.bytes, "utf8");
        } else if (stdin.kind === "fd") {
          stdin.stream.on("error", () => {});
          stdin.stream.pipe(childStdin);
        } else {
          const rs = createReadStream(stdin.path);
          rs.on("error", () => {
            try {
              childStdin.end();
            } catch {
              // best-effort: child may have already exited
            }
          });
          rs.pipe(childStdin);
        }
      }
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
    stdin?: StdinSource,
    onSpawn?: (stdout: Readable | undefined) => void,
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
      stdin,
      onSpawn,
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
   * the workspace, matching script cwd semantics. Shell lines have no
   * definition site and therefore no `use` clause, so they get the same
   * sterile env as an inline script: base process mechanics plus the runtime
   * contract keys — never ambient host secrets or kernel keys.
   */
  private executeShLine(scope: Scope, command: string, io: StepIO): Promise<StepResult> {
    const env = this.buildScriptSpawnEnv(scope.env, undefined);
    return this.spawnAndCapture(resolveShell(), ["-c", command], env, this.scriptCwd(scope.env, scope.filePath), io);
  }

  private async executeInlineScript(
    scope: Scope,
    body: string,
    shebang: string | undefined,
    argsRaw: string,
    stdin?: StdinSource,
    onSpawn?: (stdout: Readable | undefined) => void,
    endGate?: Promise<unknown>,
  ): Promise<StepResult> {
    const resolvedArgs = await this.resolveArgsRaw(scope, argsRaw);
    if (!Array.isArray(resolvedArgs)) return resolvedArgs;
    const args = resolvedArgs;
    const scriptName = inlineScriptName(body, shebang);
    // Inline scripts have no `use` clause, so they get the sterile base only.
    const scriptEnv = this.buildScriptSpawnEnv(scope.env, undefined);
    return this.executeManagedStep(
      "script",
      scriptName,
      args,
      async (io) => this.executeScript(scope.filePath, scriptName, args, scriptEnv, io, stdin, onSpawn),
      undefined,
      endGate,
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

  private resolveConfigAgentModel(scope: Scope, filePath: string): string | undefined {
    const ctx = this.defCtxStack[this.defCtxStack.length - 1];
    const moduleMeta = this.graph.modules.get(filePath)?.ast.metadata;
    const defMeta = ctx?.defMeta;
    const layered: DefMetadata = {};
    if (moduleMeta?.agent?.model !== undefined) {
      layered.agent = { model: moduleMeta.agent.model };
    }
    if (defMeta?.agent?.model !== undefined) {
      (layered.agent ??= {}).model = defMeta.agent.model;
    }
    if (layered.agent?.model === undefined) return undefined;
    return interpolateDefMetadata(layered, scope.vars, scope.env).agent?.model;
  }

  /**
   * The audit-chain key and the journal path must never reach a script (or,
   * via this scoped env, a prompt-agent) subprocess: without the key the
   * audited workflow cannot forge a run_summary.jsonl chain that verifies,
   * and without the path it is not even handed the file to overwrite
   * (finding H-3). Deletes in place on the caller's fresh copy. `this.env`
   * keeps both — the trusted kernel writes the journal and
   * `appendRunSummaryLine` reads the path from `process.env`.
   */
  private scrubKernelKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    delete env[CHAIN_KEY_ENV];
    delete env.JAIPH_RUN_SUMMARY_FILE;
    return env;
  }

  /** Sterile script subprocess env (see `buildScriptEnv` in env-allowlist.ts). */
  private buildScriptSpawnEnv(
    scopeEnv: NodeJS.ProcessEnv,
    useKeys: readonly string[] | undefined,
  ): NodeJS.ProcessEnv {
    return buildScriptEnv(scopeEnv, useKeys, this.envGrantKeys, this.grantValues);
  }

  private applyMetadataScope(
    parentEnv: NodeJS.ProcessEnv,
    moduleMeta: DefMetadata | undefined,
    defMeta: DefMetadata | undefined,
    vars: Map<string, string> | undefined,
    // Only the entry module's config may set the execution-binary keys
    // (agent.command / agent.backend) and the trust/argv/run-dir keys
    // (agent.trusted_workspace / agent.cursor_flags / agent.claude_flags /
    // run.logs_dir) by default. Set the matching JAIPH_*_IMPORT_UNLOCK=1 var to
    // allow imported modules to override (advanced use).
    fromEntryModule: boolean,
  ): NodeJS.ProcessEnv {
    const nextEnv: NodeJS.ProcessEnv = { ...parentEnv };
    const apply = (meta?: DefMetadata): void => {
      if (!meta) return;
      const resolved = vars ? interpolateDefMetadata(meta, vars, parentEnv) : meta;
      if (parentEnv.JAIPH_AGENT_COMMAND_LOCKED !== "1" && resolved.agent?.command !== undefined) {
        if (fromEntryModule || parentEnv.JAIPH_AGENT_COMMAND_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_AGENT_COMMAND = resolved.agent.command;
        }
      }
      if (parentEnv.JAIPH_AGENT_BACKEND_LOCKED !== "1" && resolved.agent?.backend !== undefined) {
        if (fromEntryModule || parentEnv.JAIPH_AGENT_BACKEND_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_AGENT_BACKEND = resolved.agent.backend;
        }
      }
      // These four keys shape the agent trust path (`--trust`), the agent argv
      // (`cursor_flags` / `claude_flags` appended by buildBackendArgs), and the
      // run directory. Like the execution-binary keys above, an imported module
      // may only set them when this call is from the entry module or the matching
      // `*_IMPORT_UNLOCK` opt-in is set. `*_LOCKED` still wins over unlock.
      if (
        parentEnv.JAIPH_AGENT_TRUSTED_WORKSPACE_LOCKED !== "1" &&
        resolved.agent?.trustedWorkspace !== undefined
      ) {
        if (fromEntryModule || parentEnv.JAIPH_AGENT_TRUSTED_WORKSPACE_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_AGENT_TRUSTED_WORKSPACE = resolved.agent.trustedWorkspace;
        }
      }
      if (parentEnv.JAIPH_AGENT_CURSOR_FLAGS_LOCKED !== "1" && resolved.agent?.cursorFlags !== undefined) {
        if (fromEntryModule || parentEnv.JAIPH_AGENT_CURSOR_FLAGS_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_AGENT_CURSOR_FLAGS = resolved.agent.cursorFlags;
        }
      }
      if (parentEnv.JAIPH_AGENT_CLAUDE_FLAGS_LOCKED !== "1" && resolved.agent?.claudeFlags !== undefined) {
        if (fromEntryModule || parentEnv.JAIPH_AGENT_CLAUDE_FLAGS_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_AGENT_CLAUDE_FLAGS = resolved.agent.claudeFlags;
        }
      }
      if (parentEnv.JAIPH_RUNS_DIR_LOCKED !== "1" && resolved.run?.logsDir !== undefined) {
        if (fromEntryModule || parentEnv.JAIPH_RUNS_DIR_IMPORT_UNLOCK === "1") {
          nextEnv.JAIPH_RUNS_DIR = resolved.run.logsDir;
        }
      }
      if (parentEnv.JAIPH_DEBUG_LOCKED !== "1" && resolved.run?.debug !== undefined) {
        nextEnv.JAIPH_DEBUG = resolved.run.debug ? "true" : "false";
      }
    };
    apply(moduleMeta);
    apply(defMeta);
    return nextEnv;
  }

  private resolveRecoverLimit(filePath: string): number {
    const activeWorkflowMeta = this.defCtxStack[this.defCtxStack.length - 1]?.defMeta;
    if (activeWorkflowMeta?.run?.recoverLimit !== undefined) {
      return activeWorkflowMeta.run.recoverLimit;
    }
    const moduleMeta = this.graph.modules.get(filePath)?.ast.metadata;
    return moduleMeta?.run?.recoverLimit ?? 10;
  }

  private async executeManagedStep(
    kind: "def" | "script",
    name: string,
    args: string[],
    fn: (io: StepIO) => Promise<StepResult>,
    declaredParamNames?: string[],
    // Ordering gate for a pipeline stage: resolves once the upstream stage has
    // emitted its own STEP_END. A stage's work still runs concurrently (its own
    // process spawns and streams in `fn`); only this stage's STEP_END emit waits
    // on it, so the progress tree reports completions in pipeline order even
    // though child `close` events race across platforms.
    endGate?: Promise<unknown>,
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
      appendOut: (chunk: string | Buffer) => {
        if (chunk.length > 0) appendFileSync(outFile, chunk);
      },
      appendErr: (chunk: string | Buffer) => {
        if (chunk.length > 0) appendFileSync(errFile, chunk);
      },
    };
    // Leaf-step idle watchdog: warn periodically while silent, and (default on)
    // terminate the step after a long idle window so a stuck leaf cannot hold
    // the run indefinitely. Only `script` steps drive a subprocess to kill.
    const killController = kind === "script" ? new AbortController() : null;
    const idleWarn = kind === "script"
      ? createStepIdleOutputWarn(this.emitter, kind, name, this.env, {
          onIdleKill: killController ? () => killController.abort() : undefined,
        })
      : null;
    const stepIo: StepIO = idleWarn || killController
      ? {
          appendOut: (chunk: string | Buffer) => {
            io.appendOut(chunk);
            if (chunk.length > 0) idleWarn?.bump();
          },
          appendErr: (chunk: string | Buffer) => {
            io.appendErr(chunk);
            if (chunk.length > 0) idleWarn?.bump();
          },
          killSignal: killController?.signal,
        }
      : io;
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
    // `result` must always be defined before the STEP_END emit below: a throw
    // from `fn` (e.g. an unexpected runtime error, or a spawn seam that rejects)
    // is converted to a status-1 failed step here so capture files and STEP_END
    // are still written. Without this the step would leave a dangling STEP_START
    // and the failure would never reach `recover` / `recover_limit`.
    let result: StepResult;
    try {
      result = await fn(stepIo);
    } catch (err) {
      result = { status: 1, output: "", error: errText(err) };
    } finally {
      idleWarn?.stop();
    }
    const elapsed = Date.now() - started;
    // A streamed leaf already wrote its stdout/stderr to disk chunk-by-chunk
    // (`io.appendOut`/`appendErr`); rewriting from the empty in-memory `output`
    // would erase the capture. Only non-streamed results (defs, mock bodies)
    // persist their in-memory `output` here.
    if (!result.streamed) {
      writeFileSync(outFile, result.output ?? "");
      writeFileSync(errFile, result.error ?? "");
    }
    // Bounded stdout preview for the run tree / telemetry. For a streamed leaf
    // this reads at most MAX_EMBED bytes off disk rather than slurping the whole
    // (possibly multi-megabyte) capture into memory.
    const outContent = result.streamed
      ? this.readCapturePreview(outFile, MAX_EMBED)
      : (result.output ?? "").slice(0, MAX_EMBED);
    // Hold this stage's STEP_END until its upstream stage has emitted its own, so
    // pipeline completions render in stage order. `elapsed_ms` above already
    // captured this stage's real duration, so the gate wait never inflates it. An
    // upstream failure still lets us finish (the gate rejection is swallowed).
    if (endGate) {
      try {
        await endGate;
      } catch {
        // upstream stage failed; still emit this stage's STEP_END in order
      }
    }
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
      out_content: outContent,
      err_content: result.status !== 0 ? (result.error ?? "").slice(0, MAX_EMBED) : "",
    });
    stack.pop();
    // Stamp the capture paths, and the output-handle byte source (`valueFile`):
    // a leaf script's own stdout capture, or a propagated `return <call>()`
    // handle for a def. A force site reads `valueFile` through `forceValue`; a
    // `catch`/`recover` binds the failed step's `outFile` as a handle.
    const valueFile = result.valueFile ?? (kind === "script" ? outFile : undefined);
    return { ...result, outFile, errFile, ...(valueFile ? { valueFile } : {}) };
  }

  /**
   * Read at most `max` bytes from a capture file without slurping the whole
   * (possibly multi-megabyte) file into memory. Used for the bounded run-tree
   * stdout preview of a streamed leaf.
   */
  private readCapturePreview(path: string, max: number): string {
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.allocUnsafe(max);
        const n = readSync(fd, buf, 0, max, 0);
        return buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return "";
    }
  }
}
