import type { StreamWriter } from "./stream-parser";
import type { PromptConfig } from "./prompt-config";

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
 */
export function runCodexBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  stderr: NodeJS.WritableStream,
  requestEnv: NodeJS.ProcessEnv = {},
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

  return new Promise((resolve) => {
    const req = httpMod.request(
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
            errBody += chunk.toString();
          });
          res.on("end", () => {
            let msg = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(errBody) as Record<string, unknown>;
              const errObj = parsed.error as Record<string, unknown> | undefined;
              if (errObj && typeof errObj.message === "string") msg += `: ${errObj.message}`;
            } catch {
              // Use raw status code only.
            }
            stderr.write(`jaiph: codex API error: ${msg}\n`);
            resolve({ final: "", status: 1 });
          });
          return;
        }

        let final = "";
        let wroteFinalHeader = false;
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data) as Record<string, unknown>;
              const choices = obj.choices as Array<Record<string, unknown>> | undefined;
              const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
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
          resolve({ final, status: 0 });
        });

        res.on("error", (err: Error) => {
          stderr.write(`jaiph: codex stream error: ${err.message}\n`);
          resolve({ final, status: 1 });
        });
      },
    );

    req.on("error", (err: Error) => {
      stderr.write(`jaiph: codex API request failed: ${err.message}\n`);
      resolve({ final: "", status: 1 });
    });

    req.write(body);
    req.end();
  });
}
