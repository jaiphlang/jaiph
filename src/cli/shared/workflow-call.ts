import { resolveRuntimeEnv } from "../run/env";
import {
  runHooksForEvent,
  stepStartHookPayload,
  stepEndHookPayload,
} from "../run/hooks";
import { CHAIN_KEY_ENV, generateChainKey, writeChainKey, redactCredentials } from "../../runtime";
import { deliverRunTelemetryDetached } from "../telemetry/otlp";
import type { StepEvent, LogEvent } from "../run/events";
import { formatCallStartLine, formatCallEndLine } from "./server-log";
import { callDefHost } from "./workflow-call-exec";
import { DEFAULT_OUTPUT_CAPS } from "./workflow-call-types";
import type {
  OutputCaps,
  DefCallContext,
  DefCallEnvironment,
  DefCallResult,
} from "./workflow-call-types";

// Public surface of the workflow-call slice. The heavy execution + result
// composition lives in the sibling `workflow-call-exec.ts` (host spawn,
// collect output, compose result), and the shared shapes + output-cap
// primitives live in `workflow-call-types.ts`. They are re-exported here so
// callers (and the executor tests) keep a single import site.
export {
  attachOutputCollector,
  composeResult,
} from "./workflow-call-exec";
export {
  DEFAULT_OUTPUT_CAPS,
  TRUNCATION_MARKER,
  capBytes,
} from "./workflow-call-types";
export type {
  CollectedOutput,
  OutputCaps,
  DefCallContext,
  DefCallEnvironment,
  DefCallResult,
} from "./workflow-call-types";

/**
 * Execute one workflow call on the host — the same spawn path as `jaiph run --raw`.
 *
 * The caller supplies `runId` so it can register the run before the child
 * exits (the HTTP server needs the id while the run is still `running`).
 *
 * Success text, in order of preference: the workflow's return value
 * (`return_value.txt`), collected `log` output, or a completion note.
 */
export async function callDef(
  env: DefCallEnvironment,
  defSymbol: string,
  positionalArgs: string[],
  runId: string,
  ctx?: DefCallContext,
  caps: OutputCaps = DEFAULT_OUTPUT_CAPS,
): Promise<DefCallResult> {
  const runtimeEnv = resolveRuntimeEnv(env.effectiveConfig, env.workspaceRoot, env.inputAbs);
  runtimeEnv.JAIPH_SOURCE_ABS = env.inputAbs;
  runtimeEnv.JAIPH_RUN_ID = runId;
  runtimeEnv.JAIPH_SCRIPTS = env.scriptsDir;
  // Per-run audit-chain key (finding H-3): forwarded to the trusted runner,
  // scrubbed from script/agent subprocess envs, and persisted beside the
  // journal below so read/export boundaries can verify integrity.
  const chainKey = generateChainKey();
  runtimeEnv[CHAIN_KEY_ENV] = chainKey;

  const startedAt = Date.now();
  if (env.hooks) {
    runHooksForEvent(env.hooks, "run_start", {
      event: "run_start",
      run_id: runId,
      timestamp: new Date().toISOString(),
      run_path: env.inputAbs,
      workspace: env.workspaceRoot,
    });
  }

  // Operator log (stderr only): per-call start banner + optional workflow-log
  // mirror. The run dir is not yet known at start (read from the meta file
  // after exit), so it lands on the end line.
  const operator = ctx?.operator;
  operator?.log.info(
    formatCallStartLine({
      def: defSymbol,
      runId,
      principal: ctx?.principal,
      correlationId: ctx?.correlationId,
    }),
  );
  const onLogEvent = buildLogMirrorHandler(operator, runId, runtimeEnv, env.extraEnv);

  const onStepEvent = buildStepEventHandler(env, ctx);
  const result = await callDefHost(env, defSymbol, positionalArgs, runtimeEnv, runId, caps, onStepEvent, ctx, onLogEvent);

  if (operator) {
    const status = result.signal ? "cancelled" : result.isError ? "failed" : "ok";
    operator.log.info(
      formatCallEndLine({
        def: defSymbol,
        status,
        exit: result.exitStatus ?? 0,
        elapsedMs: Date.now() - startedAt,
        rundir: result.runDir,
        principal: ctx?.principal,
        correlationId: ctx?.correlationId,
      }),
    );
  }

  if (env.hooks) {
    runHooksForEvent(env.hooks, "run_end", {
      event: "run_end",
      run_id: runId,
      status: result.isError ? (result.exitStatus || 1) : 0,
      elapsed_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      run_path: env.inputAbs,
      workspace: env.workspaceRoot,
      run_dir: result.runDir,
    });
  }
  // One export per call — the shared choke point covering every MCP tool call and
  // HTTP `jaiph serve` invocation. Detached (fire-and-forget): returning here lets
  // the caller mark the run terminal and release its execution-concurrency slot
  // before best-effort delivery, so an unreachable backend can never delay a
  // terminal result or hold a slot. Delivery failures are tracked as bounded
  // metrics; never changes the call result.
  if (result.runDir) writeChainKey(result.runDir, chainKey);
  deliverRunTelemetryDetached({
    runDir: result.runDir,
    def: defSymbol,
    exitStatus: result.exitStatus ?? 0,
    signal: result.signal ?? null,
    env: process.env,
    // Principal + correlation surface on telemetry only (OTLP resource attrs,
    // Sentry tags) — deliberately not written into the run's journal.
    identity: { principal: ctx?.principal, correlationId: ctx?.correlationId },
  });
  return result;
}

/**
 * Combined per-step-event handler for one call: dispatches the step hooks
 * (when configured) and forwards the caller's progress callback.
 */
function buildStepEventHandler(
  env: DefCallEnvironment,
  ctx: DefCallContext | undefined,
): (ev: StepEvent) => void {
  return (ev) => {
    if (env.hooks) {
      if (ev.type === "STEP_START") {
        runHooksForEvent(env.hooks, "step_start", stepStartHookPayload(ev, ev.id, env.inputAbs, env.workspaceRoot));
      } else {
        runHooksForEvent(env.hooks, "step_end", stepEndHookPayload(ev, ev.id, env.inputAbs, env.workspaceRoot));
      }
    }
    ctx?.onStep?.(ev.kind, ev.name);
  };
}

/**
 * Build the workflow-log mirror handler for one call, or `undefined` when
 * mirroring is off (the default) or there is no operator log. When on, every
 * workflow LOG/LOGWARN/LOGERR event is mirrored to the operator log (stderr),
 * colorized by level with the same depth / async-branch subscript indent as the
 * interactive tree. The message is credential-redacted through the same
 * boundary as the durable journal / call-result text — redaction uses the
 * runtime env plus `--env` passthrough so a secret can never leak to stderr.
 */
function buildLogMirrorHandler(
  operator: DefCallContext["operator"],
  runId: string,
  runtimeEnv: Record<string, string | undefined>,
  extraEnv: Record<string, string>,
): ((ev: LogEvent) => void) | undefined {
  if (!operator || !operator.log.mirrorWorkflowLog) return undefined;
  const redactEnv = { ...runtimeEnv, ...extraEnv };
  return (ev) => {
    operator.log.mirror(ev.type, redactCredentials(ev.message, redactEnv), {
      runId,
      depth: ev.depth,
      asyncIndices: ev.async_indices,
    });
  };
}
