import type { ConfigBodyPart, WorkflowMetadata } from "../types";
import { colFromRaw, fail } from "./core";
import { findClosingBraceIndex, splitStatementsOnSemicolons } from "./statement-split";

const ALLOWED_KEYS = new Set([
  "agent.default_model",
  "agent.command",
  "agent.backend",
  "agent.trusted_workspace",
  "agent.cursor_flags",
  "agent.claude_flags",
  "run.logs_dir",
  "run.debug",
  "run.inbox_parallel",
  "runtime.docker_enabled",
  "runtime.docker_image",
  "runtime.docker_network",
  "runtime.docker_timeout",
  "runtime.workspace",
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
  "run.inbox_parallel": "boolean",
  "runtime.docker_enabled": "boolean",
  "runtime.docker_image": "string",
  "runtime.docker_network": "string",
  "runtime.docker_timeout": "number",
  "runtime.workspace": "string[]",
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

function assignConfigKey(
  filePath: string,
  out: WorkflowMetadata,
  key: string,
  value: string | boolean | number | string[],
  lineNo: number,
  raw: string,
): void {
  validateKeyType(filePath, key, value, lineNo, raw);

  if (key === "agent.default_model") {
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.defaultModel = value as string;
  } else if (key === "agent.command") {
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.command = value as string;
  } else if (key === "agent.backend") {
    const backend = value === "cursor" || value === "claude" || value === "codex" ? value : undefined;
    if (!backend) {
      fail(
        filePath,
        'agent.backend must be "cursor", "claude", or "codex"',
        lineNo,
        colFromRaw(raw),
      );
    }
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.backend = backend;
  } else if (key === "agent.trusted_workspace") {
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.trustedWorkspace = value as string;
  } else if (key === "agent.cursor_flags") {
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.cursorFlags = value as string;
  } else if (key === "agent.claude_flags") {
    if (!out.agent) {
      out.agent = {};
    }
    out.agent.claudeFlags = value as string;
  } else if (key === "run.logs_dir") {
    if (!out.run) {
      out.run = {};
    }
    out.run.logsDir = value as string;
  } else if (key === "run.debug") {
    if (!out.run) {
      out.run = {};
    }
    out.run.debug = value as boolean;
  } else if (key === "run.inbox_parallel") {
    if (!out.run) {
      out.run = {};
    }
    out.run.inboxParallel = value as boolean;
  } else if (key === "runtime.docker_enabled") {
    if (!out.runtime) {
      out.runtime = {};
    }
    out.runtime.dockerEnabled = value as boolean;
  } else if (key === "runtime.docker_image") {
    if (!out.runtime) {
      out.runtime = {};
    }
    out.runtime.dockerImage = value as string;
  } else if (key === "runtime.docker_network") {
    if (!out.runtime) {
      out.runtime = {};
    }
    out.runtime.dockerNetwork = value as string;
  } else if (key === "runtime.docker_timeout") {
    if (!out.runtime) {
      out.runtime = {};
    }
    out.runtime.dockerTimeout = value as number;
  } else if (key === "runtime.workspace") {
    if (!out.runtime) {
      out.runtime = {};
    }
    out.runtime.workspace = value as string[];
  }
}

export function parseConfigBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
): { metadata: WorkflowMetadata; nextIndex: number } {
  const openLineNo = startIndex + 1;
  const rawOpen = lines[startIndex];
  const lineOpen = rawOpen.trim();

  if (!lineOpen.startsWith("config") || !lineOpen.includes("{")) {
    return fail(filePath, "expected config block: config {", openLineNo, colFromRaw(rawOpen));
  }

  const openBraceIdx = rawOpen.indexOf("{");
  const closeIdx = findClosingBraceIndex(rawOpen, openBraceIdx);
  if (closeIdx !== -1) {
    const tail = rawOpen.slice(closeIdx + 1).trim();
    if (tail !== "") {
      return fail(filePath, "unexpected content after closing '}' of config block", openLineNo, colFromRaw(rawOpen));
    }
    const inner = rawOpen.slice(openBraceIdx + 1, closeIdx);
    const out: WorkflowMetadata = {};
    const bodySequence: ConfigBodyPart[] = [];
    const assignmentLines = splitStatementsOnSemicolons(inner);
    for (const assignRaw of assignmentLines) {
      const line = assignRaw.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("#")) {
        bodySequence.push({ kind: "comment", text: line });
        continue;
      }
      const eq = line.indexOf("=");
      if (eq === -1) {
        return fail(filePath, `config line must be key = value: ${line}`, openLineNo, colFromRaw(rawOpen));
      }
      const key = line.slice(0, eq).trim();
      const valuePart = line.slice(eq + 1);

      if (!ALLOWED_KEYS.has(key)) {
        return fail(
          filePath,
          `unknown config key: ${key}. Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
          openLineNo,
          colFromRaw(rawOpen),
        );
      }

      let value: string | boolean | number | string[];
      const trimmedValue = valuePart.trim();
      if (trimmedValue === "[") {
        return fail(
          filePath,
          "multiline config arrays require a multiline config { … } block (opening 'config {' alone on its own line)",
          openLineNo,
          colFromRaw(rawOpen),
        );
      }
      if (key === "runtime.workspace" && trimmedValue.startsWith("[") && trimmedValue !== "[]") {
        return fail(
          filePath,
          "runtime.workspace arrays with elements require a multiline config { … } block",
          openLineNo,
          colFromRaw(rawOpen),
        );
      }
      value = parseMetadataValue(filePath, rawOpen, valuePart, openLineNo);
      assignConfigKey(filePath, out, key, value, openLineNo, rawOpen);
      bodySequence.push({ kind: "assign", key });
    }
    if (bodySequence.length > 0) {
      out.configBodySequence = bodySequence;
    }
    return { metadata: out, nextIndex: startIndex + 1 };
  }

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
      if (bodySequence.length > 0) {
        out.configBodySequence = bodySequence;
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
