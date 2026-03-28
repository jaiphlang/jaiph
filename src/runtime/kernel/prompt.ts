// JS kernel: prompt execution (replaces jaiph::prompt_impl in jaiph_stdlib.sh).
// Called from bash: echo "$prompt_text" | node kernel/prompt.js [preview] [named_args...]
// Env vars: JAIPH_AGENT_BACKEND, JAIPH_AGENT_COMMAND, JAIPH_AGENT_MODEL,
//   JAIPH_AGENT_TRUSTED_WORKSPACE, JAIPH_AGENT_CURSOR_FLAGS, JAIPH_AGENT_CLAUDE_FLAGS,
//   JAIPH_WORKSPACE, JAIPH_TEST_MODE, JAIPH_MOCK_DISPATCH_SCRIPT,
//   JAIPH_MOCK_RESPONSES_FILE, JAIPH_PROMPT_FINAL_FILE

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { parseStream, type StreamWriter } from "./stream-parser";
import { readNextMockResponse, mockDispatch } from "./mock";

export type PromptConfig = {
  backend: string;
  agentCommand: string;
  model: string;
  workspaceRoot: string;
  trustedWorkspace: string;
  cursorFlags: string[];
  claudeFlags: string[];
  promptFinalFile: string;
};

export function resolveConfig(): PromptConfig {
  const env = process.env;
  const workspaceRoot = env.JAIPH_WORKSPACE || process.cwd();
  return {
    backend: env.JAIPH_AGENT_BACKEND || "cursor",
    agentCommand: env.JAIPH_AGENT_COMMAND || "cursor-agent",
    model: env.JAIPH_AGENT_MODEL || "",
    workspaceRoot,
    trustedWorkspace: env.JAIPH_AGENT_TRUSTED_WORKSPACE || workspaceRoot,
    cursorFlags: env.JAIPH_AGENT_CURSOR_FLAGS ? env.JAIPH_AGENT_CURSOR_FLAGS.split(/\s+/).filter(Boolean) : [],
    claudeFlags: env.JAIPH_AGENT_CLAUDE_FLAGS ? env.JAIPH_AGENT_CLAUDE_FLAGS.split(/\s+/).filter(Boolean) : [],
    promptFinalFile: env.JAIPH_PROMPT_FINAL_FILE || "",
  };
}

function isTestMode(): boolean {
  return process.env.JAIPH_TEST_MODE === "1";
}

/**
 * Escape a string the way bash `printf "%q"` does (backslash-escaping).
 * Matches jaiph::format_shell_command output exactly.
 */
function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  // If the string contains only safe chars, return as-is
  if (/^[a-zA-Z0-9_./:@=,+%-]+$/.test(s)) return s;
  // Use $'...' quoting for strings with control characters (newlines, tabs, etc.)
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return "$'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      .replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r") + "'";
  }
  // Backslash-escape special characters (matches printf %q for simple cases)
  return s.replace(/([^a-zA-Z0-9_./:@=,+%-])/g, "\\$1");
}

/** Format a shell command for log display (matches jaiph::format_shell_command). */
function formatShellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Build the command args for the selected backend. */
export function buildBackendArgs(config: PromptConfig, promptText: string): { command: string; args: string[] } {
  if (config.backend === "claude") {
    return {
      command: "claude",
      args: ["-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages", ...config.claudeFlags],
    };
  }
  // cursor backend
  const commandParts = config.agentCommand.split(/\s+/).filter(Boolean);
  const command = commandParts[0];
  const baseArgs = [...commandParts.slice(1), "--print", "--output-format", "stream-json", "--stream-partial-output"];
  baseArgs.push("--workspace", config.workspaceRoot);
  if (config.model) baseArgs.push("--model", config.model);
  baseArgs.push("--trust", config.trustedWorkspace);
  baseArgs.push(...config.cursorFlags);
  baseArgs.push(promptText);
  return { command, args: baseArgs };
}

/** Check if a command exists in PATH. */
function commandExists(cmd: string): boolean {
  try {
    execFileSync("command", ["-v", cmd], { stdio: "ignore", shell: true });
    return true;
  } catch {
    return false;
  }
}

/** Run the backend process and parse its streaming output. */
function runBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
): Promise<{ final: string; status: number }> {
  // Pre-flight check for claude backend
  if (config.backend === "claude" && !commandExists("claude")) {
    process.stderr.write(
      'jaiph: agent.backend is "claude" but the Claude CLI (claude) was not found in PATH. ' +
      'Install the Anthropic Claude CLI or set agent.backend = "cursor" (or JAIPH_AGENT_BACKEND=cursor).\n',
    );
    return Promise.resolve({ final: "", status: 1 });
  }

  return new Promise((resolve) => {
    const { command, args } = buildBackendArgs(config, promptText);
    const isClaude = config.backend === "claude";
    // Cursor: stdin is not used (prompt is passed as arg), stderr passes through to caller.
    // Claude: stdin receives prompt, stdout+stderr are merged for parsing (matches `2>&1 |`).
    const child = nodeSpawn(command, args, {
      stdio: isClaude ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err) => {
      process.stderr.write(`jaiph: failed to start ${command}: ${err.message}\n`);
      resolve({ final: "", status: 1 });
    });

    if (isClaude && child.stdin) {
      child.stdin.write(promptText);
      child.stdin.end();
    }

    let parseInput: import("node:stream").Readable;
    if (isClaude) {
      // Claude: merge stdout + stderr for parsing (matches bash `2>&1 |` behavior)
      const { PassThrough } = require("node:stream") as typeof import("node:stream");
      const merged = new PassThrough();
      child.stdout?.pipe(merged);
      child.stderr?.pipe(merged);
      child.on("close", () => merged.end());
      parseInput = merged;
    } else {
      // Cursor: parse only stdout; pipe stderr through to process stderr
      parseInput = child.stdout!;
      child.stderr?.pipe(process.stderr);
    }

    parseStream(parseInput, writer).then((final) => {
      child.on("close", (code) => {
        resolve({ final, status: code ?? 0 });
      });
      if (child.exitCode !== null) {
        resolve({ final, status: child.exitCode });
      }
    });
  });
}

function writeFinalFile(filePath: string, content: string): void {
  if (filePath) {
    try {
      writeFileSync(filePath, content, "utf8");
    } catch {
      // Best-effort final capture
    }
  }
}

/** Core prompt execution logic. Returns final text and exit status. */
export async function executePrompt(
  promptText: string,
  config: PromptConfig,
  stdout: NodeJS.WritableStream,
): Promise<{ final: string; status: number }> {
  // Test mode: check mocks first
  if (isTestMode()) {
    const dispatchScript = process.env.JAIPH_MOCK_DISPATCH_SCRIPT || "";
    if (dispatchScript) {
      const result = mockDispatch(promptText, dispatchScript);
      if (result.status === 0) {
        writeFinalFile(config.promptFinalFile, result.response);
        stdout.write(result.response);
        if (!result.response.endsWith("\n")) {
          stdout.write("\n");
        }
        return { final: result.response, status: 0 };
      }
      return { final: "", status: result.status };
    }
    const mockFile = process.env.JAIPH_MOCK_RESPONSES_FILE || "";
    if (mockFile) {
      const mockResult = readNextMockResponse(mockFile);
      if (mockResult !== null) {
        writeFinalFile(config.promptFinalFile, mockResult);
        stdout.write(mockResult);
        if (!mockResult.endsWith("\n")) {
          stdout.write("\n");
        }
        return { final: mockResult, status: 0 };
      }
    }
    // No mock set or no match: fall through to real backend
  }

  // Log command and prompt text
  if (promptText) {
    const { command, args } = buildBackendArgs(config, promptText);
    let commandLog: string;
    if (config.backend === "claude") {
      // Match bash format: printf %s <escaped> \| <command...>
      commandLog = `printf %s ${shellQuote(promptText)} \\| ${formatShellCommand([command, ...args])}`;
    } else {
      commandLog = formatShellCommand([command, ...args]);
    }
    stdout.write(`Command:\n${commandLog}\n\n`);
    stdout.write(`Prompt:\n${promptText}\n\n`);
  }

  const writer: StreamWriter = {
    writeReasoning: (text) => stdout.write(text),
    writeFinal: (text) => stdout.write(text),
  };

  const result = await runBackend(config, promptText, writer);
  writeFinalFile(config.promptFinalFile, result.final);
  if (promptText) {
    stdout.write("\n");
  }
  return result;
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
