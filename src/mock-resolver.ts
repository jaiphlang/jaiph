/**
 * Loads mock definitions from a .test.toml file and resolves prompt text to a mock response.
 * Used by `jaiph test` to substitute prompt calls without invoking the real agent.
 *
 * Reads prompt text from stdin; writes mock response to stdout or error to stderr and exits non-zero.
 */

import { readFileSync } from "node:fs";

export interface MockDef {
  prompt_contains: string;
  response: string;
}

/**
 * Minimal parser for .jaiph/tests/*.test.toml format:
 *   [[mock]]
 *   prompt_contains = "substring"
 *   response = 'response body'
 */
export function loadMocks(tomlPath: string): MockDef[] {
  const raw = readFileSync(tomlPath, "utf8");
  const mocks: MockDef[] = [];
  const blocks = raw.split(/\[\[mock\]\]/);
  for (let i = 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    const promptMatch = block.match(/prompt_contains\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/);
    const responseMatch = block.match(/response\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/);
    if (!promptMatch || !responseMatch) {
      continue;
    }
    const prompt_contains = unquote(promptMatch[1]);
    const response = unquote(responseMatch[1]);
    mocks.push({ prompt_contains, response });
  }
  return mocks;
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
    const q = s[0];
    if (s[s.length - 1] === q) {
      s = s.slice(1, -1);
      if (q === '"') {
        return s.replace(/\\(.)/g, (_, c) => c);
      }
      return s.replace(/''/g, "'");
    }
  }
  return s;
}

/**
 * Returns the first mock whose prompt_contains is a substring of promptText, or null.
 */
export function resolveMock(mocks: MockDef[], promptText: string): string | null {
  for (const mock of mocks) {
    if (promptText.includes(mock.prompt_contains)) {
      return mock.response;
    }
  }
  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write("Usage: mock-resolver <mock-file.test.toml> [prompt-text]\n");
    process.stderr.write("  If prompt-text is omitted, reads prompt from stdin.\n");
    process.exit(1);
  }
  const mockPath = args[0];
  let promptText: string;
  if (args.length >= 2) {
    promptText = args.slice(1).join(" ");
  } else {
    try {
      promptText = readFileSync(0, "utf8").trim();
    } catch {
      promptText = "";
    }
  }
  const mocks = loadMocks(mockPath);
  const response = resolveMock(mocks, promptText);
  if (response === null) {
    process.stderr.write(`jai: no mock matched prompt (prompt_contains substring). Prompt preview: ${promptText.slice(0, 80)}...\n`);
    process.exit(1);
  }
  process.stdout.write(response);
}

if (require.main === module) {
  main();
}
