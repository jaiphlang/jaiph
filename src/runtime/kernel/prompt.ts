// Prompt execution: dispatch the configured agent backend and stream its
// output. This module owns the top-level `executePrompt` orchestration (mock
// dispatch, transcript headers, final-answer capture) and the script entry
// point; the config/model helpers, Claude env prep, the Codex HTTP backend, and
// the subprocess dispatch + watchdog live in sibling `prompt-*.ts` files. Their
// public surface is re-exported here so `./prompt` stays the one import site.

import { writeFileSync } from "node:fs";
import { consumeNextMockResponse, dispatchMockArms, type MockPromptArm } from "./mock";
import type { StreamWriter } from "./stream-parser";
import {
  buildBackendArgs,
  isCustomCommand,
  isTestMode,
  resolveConfig,
  shellQuote,
  type PromptConfig,
} from "./prompt-config";
import { runBackend } from "./prompt-backends";

export {
  BACKEND_DEFAULT_MODEL_LABEL,
  DEFAULT_PROMPT_COMPLETION_GRACE_MS,
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_PROMPT_MAX_DURATION_MS,
  buildBackendArgs,
  isCustomCommand,
  modelForStepEvent,
  resolveConfig,
  resolveModel,
  resolvePromptConfig,
  resolvePromptStepName,
  shellQuote,
} from "./prompt-config";
export type { ModelResolution, PromptConfig } from "./prompt-config";
export { prepareClaudeEnv, resolveClaudeFallbackConfigDir } from "./prompt-claude";
export type { ClaudeEnvPreparation } from "./prompt-claude";
export { installPromptWatchdog, runBackend } from "./prompt-backends";

function writeFinalFile(filePath: string, content: string): void {
  if (filePath) {
    try {
      writeFileSync(filePath, content, "utf8");
    } catch {
      // Best-effort final capture
    }
  }
}

/** Emit a mock/backend final answer to the transcript + final-capture file, ensuring a trailing newline. */
function emitFinalAnswer(
  text: string,
  config: PromptConfig,
  stdout: NodeJS.WritableStream,
): { final: string; status: number } {
  writeFinalFile(config.promptFinalFile, text);
  stdout.write(text);
  if (!text.endsWith("\n")) {
    stdout.write("\n");
  }
  return { final: text, status: 0 };
}

/** Remove only surrounding blank lines while preserving inner formatting. */
function trimSurroundingBlankLines(input: string): string {
  return input.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

/** Format a shell command for log display (matches jaiph::format_shell_command). */
function formatShellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Write Command:/Prompt: headers (same for real runs and test mocks) for run artifacts. */
function writePromptTranscriptHeader(
  stdout: NodeJS.WritableStream,
  config: PromptConfig,
  promptText: string,
): void {
  if (!promptText) return;
  const { command, args } = buildBackendArgs(config, promptText);
  let commandLog: string;
  if (config.backend === "codex") {
    commandLog = formatShellCommand([command, ...args]);
  } else if (config.backend === "claude" || isCustomCommand(config)) {
    // Claude and custom commands: prompt piped via stdin.
    commandLog = `printf %s ${shellQuote(promptText)} \\| ${formatShellCommand([command, ...args])}`;
  } else {
    commandLog = formatShellCommand([command, ...args]);
  }
  stdout.write(`Command:\n${commandLog}\n\n`);
  stdout.write(`Prompt:\n${promptText}\n\n`);
}

/** Core prompt execution logic. Returns final text and exit status. */
export async function executePrompt(
  promptText: string,
  config: PromptConfig,
  stdout: NodeJS.WritableStream,
  /** Workflow/runtime env (JAIPH_TEST_MODE and mocks); defaults to process.env for CLI entry. */
  execEnv: NodeJS.ProcessEnv = process.env,
  stderr: NodeJS.WritableStream = process.stderr,
  /**
   * Named-prompt `use` keys granted via `--env`, injected into the agent
   * subprocess on top of `scrubPromptEnv`. Anonymous prompts pass nothing.
   */
  useEnv?: NodeJS.ProcessEnv,
): Promise<{ final: string; status: number }> {
  writePromptTranscriptHeader(stdout, config, promptText);

  // Test mode: check mocks first
  if (isTestMode(execEnv)) {
    const armsJson = execEnv.JAIPH_MOCK_PROMPT_ARMS_JSON || "";
    if (armsJson) {
      let arms: MockPromptArm[] = [];
      try {
        arms = JSON.parse(armsJson) as MockPromptArm[];
      } catch {
        stderr.write(`jaiph: invalid JAIPH_MOCK_PROMPT_ARMS_JSON\n`);
        return { final: "", status: 1 };
      }
      const result = dispatchMockArms(promptText, arms);
      if (result.status === 0) {
        return emitFinalAnswer(result.response, config, stdout);
      }
      return { final: "", status: result.status };
    }
    const responsesJson = execEnv.JAIPH_MOCK_RESPONSES_JSON || "";
    if (responsesJson) {
      const mockResult = consumeNextMockResponse(responsesJson);
      if (mockResult !== null) {
        return emitFinalAnswer(mockResult, config, stdout);
      }
    }
    // No mock set or no match: fall through to real backend
  }

  const writer: StreamWriter = {
    writeReasoning: (text) => stdout.write(text),
    writeFinal: (text) => stdout.write(text),
  };

  const result = await runBackend(config, promptText, writer, execEnv, stderr, useEnv);
  const final =
    config.backend === "cursor"
      ? trimSurroundingBlankLines(result.final)
      : result.final;
  writeFinalFile(config.promptFinalFile, final);
  if (promptText) {
    stdout.write("\n");
  }
  return { final, status: result.status };
}

/** Read prompt text from stdin. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

// Main entry point when run as script
async function main(): Promise<void> {
  const stdinText = await readStdin();
  const promptText = stdinText || process.argv.slice(2).join(" ");
  const config = resolveConfig();
  const result = await executePrompt(promptText, config, process.stdout);
  process.exit(result.status);
}

// Run only when executed directly (not when imported for testing)
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`jaiph kernel: ${err}\n`);
    process.exit(1);
  });
}
