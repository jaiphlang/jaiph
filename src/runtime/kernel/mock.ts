// JS kernel: test-mode mock helpers.
// Ports jaiph::read_next_mock_response and jaiph::mock_dispatch from test-mode.sh.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Read and consume the first line from the mock responses file.
 * Returns the line or null if empty/missing.
 */
export function readNextMockResponse(filePath: string): string | null {
  if (!filePath || !existsSync(filePath)) {
    process.stderr.write("jaiph: no mock for prompt (JAIPH_MOCK_RESPONSES_FILE missing or not a file)\n");
    return null;
  }
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const firstLine = lines[0];
  if (!firstLine) return null;
  // Consume: write remaining lines back
  const remaining = lines.slice(1).join("\n");
  try {
    writeFileSync(filePath, remaining, "utf8");
  } catch {
    // best-effort
  }
  return firstLine;
}

/**
 * Run the mock dispatch script with prompt text as $1.
 * Returns { response, status }.
 */
export function mockDispatch(
  promptText: string,
  scriptPath: string,
): { response: string; status: number } {
  if (!scriptPath || !existsSync(scriptPath)) {
    process.stderr.write("jaiph: no mock for prompt (JAIPH_MOCK_DISPATCH_SCRIPT missing or not executable)\n");
    return { response: "", status: 1 };
  }
  try {
    const result = execFileSync(scriptPath, [promptText], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { response: result, status: 0 };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stderr?: string };
    if (execErr.stderr) process.stderr.write(execErr.stderr);
    return { response: "", status: execErr.status ?? 1 };
  }
}
