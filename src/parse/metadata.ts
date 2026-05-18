import type { WorkflowMetadata } from "../types";
import type { Trivia, ConfigBodyPart } from "./trivia";
import { colFromRaw, fail } from "./core";

const ALLOWED_KEYS = new Set([
  "agent.default_model",
  "agent.command",
  "agent.backend",
  "agent.trusted_workspace",
  "agent.cursor_flags",
  "agent.claude_flags",
  "run.logs_dir",
  "run.debug",
  "run.recover_limit",
  "runtime.docker_image",
  "runtime.docker_network",
  "runtime.docker_timeout_seconds",
  "module.name",
  "module.version",
  "module.description",
]);

/** Expected value type for each key that needs type validation. */
const KEY_TYPES: Record<string, "string" | "boolean" | "number" | "string[]"> = {
  "agent.default_model": "string",
  "agent.command": "string",
  "agent.backend": "string",
  "agent.trusted_workspace": "string",
  "agent.cursor_flags": "string",
  "agent.claude_flags": "string",
  "run.logs_dir": "string",
  "run.debug": "boolean",
  "run.recover_limit": "number",
  "runtime.docker_image": "string",
  "runtime.docker_network": "string",
  "runtime.docker_timeout_seconds": "number",
  "module.name": "string",
  "module.version": "string",
  "module.description": "string",
};

function parseMetadataValue(filePath: string, rawLine: string, valuePart: string, lineNo: number): string | boolean | number | string[] {
  const trimmed = valuePart.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "[]") {
    return [];
  }
  if (trimmed.startsWith(`'`)) {
    return fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo, colFromRaw(rawLine));
  }
  if (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, `"`).replace(/\\\\/g, `\\`);
  }
  const col = rawLine.indexOf(valuePart) >= 0 ? colFromRaw(rawLine) : 1;
  return fail(filePath, `config value must be a quoted string or true/false: ${trimmed}`, lineNo, col);
}

function validateKeyType(
  filePath: string,
  key: string,
  value: string | boolean | number | string[],
  lineNo: number,
  raw: string,
): void {
  const expected = KEY_TYPES[key];
  if (!expected) return;

  if (expected === "string" && typeof value !== "string") {
    return fail(filePath, `${key} must be a string`, lineNo, colFromRaw(raw));
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    return fail(filePath, `${key} must be true or false`, lineNo, colFromRaw(raw));
  }
  if (expected === "number" && typeof value !== "number") {
    return fail(filePath, `${key} must be an integer`, lineNo, colFromRaw(raw));
  }
  if (expected === "string[]" && !Array.isArray(value)) {
    return fail(filePath, `${key} must be an array of strings`, lineNo, colFromRaw(raw));
  }
}

function parseArrayValue(
  filePath: string,
  lines: string[],
  startIdx: number,
): { value: string[]; nextIndex: number } {
  const result: string[] = [];
  let idx = startIdx;

  for (; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const line = raw.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line === "]" || line === "],") {
      return { value: result, nextIndex: idx };
    }

    // Strip inline comment first, then trailing comma
    let element = line;
    // Remove inline comment
    const commentIdx = element.indexOf(" #");
    if (commentIdx >= 0) {
      element = element.slice(0, commentIdx).trimEnd();
    }
    // Remove trailing comma
    if (element.endsWith(",")) {
      element = element.slice(0, -1).trimEnd();
    }

    if (element.startsWith(`'`)) {
      return fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo, colFromRaw(raw));
    }
    if (element.startsWith(`"`) && element.endsWith(`"`)) {
      result.push(
        element.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, `"`).replace(/\\\\/g, `\\`),
      );
    } else {
      return fail(filePath, `array elements must be quoted strings: ${element}`, lineNo, colFromRaw(raw));
    }
  }

  return fail(filePath, "array not closed with ']'", startIdx, 1);
}

type ConfigValue = string | boolean | number | string[];

const KEY_SETTERS: Record<string, (out: WorkflowMetadata, value: ConfigValue) => void> = {
  "agent.default_model": (m, v) => ((m.agent ??= {}).defaultModel = v as string),
  "agent.command": (m, v) => ((m.agent ??= {}).command = v as string),
  "agent.trusted_workspace": (m, v) => ((m.agent ??= {}).trustedWorkspace = v as string),
  "agent.cursor_flags": (m, v) => ((m.agent ??= {}).cursorFlags = v as string),
  "agent.claude_flags": (m, v) => ((m.agent ??= {}).claudeFlags = v as string),
  "run.logs_dir": (m, v) => ((m.run ??= {}).logsDir = v as string),
  "run.debug": (m, v) => ((m.run ??= {}).debug = v as boolean),
  "run.recover_limit": (m, v) => ((m.run ??= {}).recoverLimit = v as number),
  "runtime.docker_image": (m, v) => ((m.runtime ??= {}).dockerImage = v as string),
  "runtime.docker_network": (m, v) => ((m.runtime ??= {}).dockerNetwork = v as string),
  "runtime.docker_timeout_seconds": (m, v) => ((m.runtime ??= {}).dockerTimeoutSeconds = v as number),
  "module.name": (m, v) => ((m.module ??= {}).name = v as string),
  "module.version": (m, v) => ((m.module ??= {}).version = v as string),
  "module.description": (m, v) => ((m.module ??= {}).description = v as string),
};

function assignConfigKey(
  filePath: string,
  out: WorkflowMetadata,
  key: string,
  value: ConfigValue,
  lineNo: number,
  raw: string,
): void {
  validateKeyType(filePath, key, value, lineNo, raw);
  if (key === "agent.backend") {
    if (value !== "cursor" && value !== "claude" && value !== "codex") {
      fail(filePath, 'agent.backend must be "cursor", "claude", or "codex"', lineNo, colFromRaw(raw));
    }
    (out.agent ??= {}).backend = value;
    return;
  }
  KEY_SETTERS[key]?.(out, value);
}

export function parseConfigBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  trivia?: Trivia,
): { metadata: WorkflowMetadata; nextIndex: number } {
  const openLineNo = startIndex + 1;
  const rawOpen = lines[startIndex];
  const lineOpen = rawOpen.trim();

  if (!/^config\s*\{\s*$/.test(lineOpen)) {
    return fail(filePath, "config block must be exactly 'config {' on its own line", openLineNo, colFromRaw(rawOpen));
  }

  const out: WorkflowMetadata = {};
  const bodySequence: ConfigBodyPart[] = [];
  let idx = startIndex + 1;

  for (; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const line = raw.trim();

    if (!line) {
      continue;
    }
    if (line.startsWith("#")) {
      bodySequence.push({ kind: "comment", text: line });
      continue;
    }
    if (line === "}") {
      if (bodySequence.length > 0 && trivia) {
        trivia.setNode(out, { configBodySequence: bodySequence });
      }
      idx += 1;
      return { metadata: out, nextIndex: idx };
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      return fail(filePath, `config line must be key = value: ${line}`, lineNo, colFromRaw(raw));
    }
    const key = line.slice(0, eq).trim();
    const valuePart = line.slice(eq + 1);

    if (!ALLOWED_KEYS.has(key)) {
      return fail(
        filePath,
        `unknown config key: ${key}. Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
        lineNo,
        colFromRaw(raw),
      );
    }

    // Check for array opening bracket
    let value: string | boolean | number | string[];
    const trimmedValue = valuePart.trim();
    bodySequence.push({ kind: "assign", key });
    if (trimmedValue === "[") {
      // Multi-line array
      const arrayResult = parseArrayValue(filePath, lines, idx + 1);
      value = arrayResult.value;
      idx = arrayResult.nextIndex;
    } else {
      value = parseMetadataValue(filePath, raw, valuePart, lineNo);
    }

    assignConfigKey(filePath, out, key, value, lineNo, raw);
  }

  return fail(filePath, "config block not closed with '}'", startIndex + 1, 1);
}
