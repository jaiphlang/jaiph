/**
 * Live + durable event emission for the Node workflow runtime.
 *
 * Owns the `__JAIPH_EVENT__` stderr stream and `run_summary.jsonl` writes for
 * workflow/step/prompt/log events, plus the monotonic step + prompt sequence
 * counters used by both the orchestrator and the prompt pipeline.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRunSummaryLine } from "./emit";
import { MAX_EMBED, nowIso, sanitizeName, stripOuterQuotes } from "./runtime-arg-parser";

export type Frame = {
  id: string;
  kind: string;
  name: string;
};

export type PromptStepHandle = {
  id: string;
  seq: number;
  outFile: string;
  errFile: string;
  backend: string;
  startedAtMs: number;
};

export type RuntimeEventEmitterDeps = {
  runId: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
  getFrameStack: () => Frame[];
  getAsyncIndices: () => number[];
};

export class RuntimeEventEmitter {
  private readonly runId: string;
  private readonly runDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly getFrameStack: () => Frame[];
  private readonly getAsyncIndices: () => number[];
  private stepSeq = 0;
  private promptSeq = 0;

  constructor(deps: RuntimeEventEmitterDeps) {
    this.runId = deps.runId;
    this.runDir = deps.runDir;
    this.env = deps.env;
    this.getFrameStack = deps.getFrameStack;
    this.getAsyncIndices = deps.getAsyncIndices;
  }

  allocStepSeq(): number {
    this.stepSeq += 1;
    return this.stepSeq;
  }

  emitWorkflow(type: "WORKFLOW_START" | "WORKFLOW_END", workflow: string): void {
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

  emitStep(payload: Record<string, unknown>): void {
    const indices = this.getAsyncIndices();
    const full = indices.length > 0 ? { ...payload, async_indices: indices } : payload;
    if (this.env.JAIPH_TEST_MODE !== "1") {
      process.stderr.write(`__JAIPH_EVENT__ ${JSON.stringify(full)}\n`);
    }
    appendRunSummaryLine(JSON.stringify({ ...full, event_version: 1 }));
  }

  emitPromptEvent(
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

  emitPromptStepStart(
    backend: string,
    scopeVars: Map<string, string>,
    rawPromptSource: string,
  ): PromptStepHandle {
    this.promptSeq += 1;
    const seq = this.allocStepSeq();
    const stack = this.getFrameStack();
    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    const id = `${this.runId}:${process.pid}:prompt:${this.promptSeq}`;
    const safe = sanitizeName("prompt__prompt");
    const outFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.out`);
    const errFile = join(this.runDir, `${String(seq).padStart(6, "0")}-${safe}.err`);
    writeFileSync(outFile, "");
    writeFileSync(errFile, "");
    // Preview keeps the authored `${var}` placeholders rather than substituted values,
    // so the tree shows what the user wrote; concrete values live alongside in params.
    const preview = stripOuterQuotes(rawPromptSource).replace(/\s+/g, " ").trim();
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

  emitPromptStepEnd(prompt: PromptStepHandle, status: number, outContent: string, errContent: string): void {
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

  emitLog(type: "LOG" | "LOGERR", message: string): void {
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
}
