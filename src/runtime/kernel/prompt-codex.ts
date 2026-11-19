import type { StreamWriter } from "./stream-parser";
import {
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_PROMPT_MAX_DURATION_MS,
  promptIdleTimeoutReason,
  promptMaxDurationReason,
  type PromptConfig,
} from "./prompt-config";

// The Codex (OpenAI Chat Completions) HTTP backend. Split out of `prompt.ts` so
// its `node:https` / `node:http` requires do not count against the sibling
// modules' fan-out, and so each prompt concern stays under the line cap.

const CODEX_DEFAULT_MODEL = "gpt-4o";

/**
 * Run a prompt against the OpenAI Chat Completions API with streaming.
 *
 * `requestEnv` is the environment for this request: the scrubbed prompt env
 * plus a named prompt's granted `use` keys (see `runBackend`). Codex has no
 * subprocess to inherit it, so nothing here reads it yet, but the parameter
 * keeps the `use` contract uniform across backends and lets tests observe it.
 *
 * Codex has no process for the leader to signal and no stream the subprocess
 * watchdog can watch, so the two activity-based prompt-watchdog layers are
 * enforced here instead: the idle timeout (resets on every received chunk) and
 * the absolute max duration. Both destroy the request and fail the prompt with
 * the same text the subprocess backends use, feeding the retry/backoff loop.
 * The completion-grace layer is subprocess-only — the codex stream ends with an
 * explicit `[DONE]` / `finish_reason`, so there is no "finished but won't exit"
 * case. `signal` is the run's abort signal; aborting it destroys the request.
 */
export function runCodexBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  stderr: NodeJS.WritableStream,
  requestEnv: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<{ final: string; status: number }> {
  if (!config.codexApiKey) {
    stderr.write(
      'jaiph: agent.backend is "codex" but OPENAI_API_KEY is not set. ' +
      "Set the OPENAI_API_KEY environment variable to your OpenAI API key.\n",
    );
    return Promise.resolve({ final: "", status: 1 });
  }

  const model = config.model || CODEX_DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: promptText }],
    stream: true,
  });

  const url = new URL(config.codexApiUrl);
  const isHttps = url.protocol === "https:";
  const httpMod = isHttps
    ? (require("node:https") as typeof import("node:https"))
    : (require("node:http") as typeof import("node:http"));

  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_PROMPT_MAX_DURATION_MS;

  return new Promise((resolve) => {
    let settled = false;
    let final = "";
    let idleTimer: NodeJS.Timeout | undefined;
    let maxTimer: NodeJS.Timeout | undefined;
    // Assigned below; referenced only from deferred callbacks, so the request is
    // always constructed before any of them can fire.
    let req: import("node:http").ClientRequest;

    const clearTimers = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      idleTimer = maxTimer = undefined;
    };

    const settle = (status: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ final, status });
    };

    // A watchdog layer fired: mirror the subprocess backends — write the same
    // reason text, destroy the request, and fail into the retry/backoff loop.
    const expire = (reason: string): void => {
      if (settled) return;
      stderr.write(`jaiph: ${reason}; terminating codex backend.\n`);
      req.destroy();
      settle(1);
    };

    // Layer 2 — idle timeout. Armed at request start and reset on every received
    // chunk, so a server that accepts the connection and stalls mid-stream fails
    // here rather than hanging the run.
    const armIdle = (): void => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expire(promptIdleTimeoutReason(idleTimeoutMs)), idleTimeoutMs);
      idleTimer.unref?.();
    };

    function onAbort(): void {
      if (settled) return;
      stderr.write("jaiph: prompt aborted; terminating codex backend.\n");
      req.destroy();
      settle(1);
    }

    req = httpMod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.codexApiKey}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (chunk: Buffer) => {
            armIdle();
            errBody += chunk.toString();
          });
          res.on("end", () => {
            if (settled) return;
            let msg = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(errBody) as Record<string, unknown>;
              const errObj = parsed.error as Record<string, unknown> | undefined;
              if (errObj && typeof errObj.message === "string") msg += `: ${errObj.message}`;
            } catch {
              // Use raw status code only.
            }
            stderr.write(`jaiph: codex API error: ${msg}\n`);
            settle(1);
          });
          return;
        }

        let wroteFinalHeader = false;
        let buffer = "";
        // A well-formed stream ends with an explicit terminator: a `[DONE]`
        // sentinel or a choice carrying a non-null `finish_reason`. A stream that
        // closes without one was cut off mid-answer and is a failure.
        let sawTerminator = false;

        res.on("data", (chunk: Buffer) => {
          armIdle();
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") {
              sawTerminator = true;
              continue;
            }
            try {
              const obj = JSON.parse(data) as Record<string, unknown>;
              const choices = obj.choices as Array<Record<string, unknown>> | undefined;
              const choice = choices?.[0];
              if (choice && choice.finish_reason != null) sawTerminator = true;
              const delta = choice?.delta as Record<string, unknown> | undefined;
              const content = delta?.content;
              if (typeof content === "string" && content.length > 0) {
                if (!wroteFinalHeader) {
                  writer.writeFinal("Final answer:\n");
                  wroteFinalHeader = true;
                }
                writer.writeFinal(content);
                final += content;
              }
            } catch {
              // Skip malformed SSE line.
            }
          }
        });

        res.on("end", () => {
          if (settled) return;
          if (sawTerminator) {
            settle(0);
            return;
          }
          stderr.write(
            "jaiph: codex stream ended without a completion marker ([DONE] or finish_reason)\n",
          );
          settle(1);
        });

        res.on("error", (err: Error) => {
          if (settled) return;
          stderr.write(`jaiph: codex stream error: ${err.message}\n`);
          settle(1);
        });
      },
    );

    req.on("error", (err: Error) => {
      if (settled) return;
      stderr.write(`jaiph: codex API request failed: ${err.message}\n`);
      settle(1);
    });

    if (maxDurationMs > 0) {
      maxTimer = setTimeout(() => expire(promptMaxDurationReason(maxDurationMs)), maxDurationMs);
      maxTimer.unref?.();
    }
    armIdle();

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    req.write(body);
    req.end();
  });
}
