import type { WorkflowMetadata } from "../types";
import { colFromRaw, fail } from "./core";

const ALLOWED_KEYS = new Set([
  "agent.default_model",
  "agent.command",
  "run.logs_dir",
  "run.debug",
]);

function parseMetadataValue(filePath: string, rawLine: string, valuePart: string, lineNo: number): string | boolean {
  const trimmed = valuePart.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if ((trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, `"`).replace(/\\\\/g, `\\`);
  }
  const col = rawLine.indexOf(valuePart) >= 0 ? colFromRaw(rawLine) : 1;
  fail(filePath, `metadata value must be a quoted string or true/false: ${trimmed}`, lineNo, col);
}

export function parseMetadataBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
): { metadata: WorkflowMetadata; nextIndex: number } {
  const openLineNo = startIndex + 1;
  const rawOpen = lines[startIndex];
  const lineOpen = rawOpen.trim();

  if (!lineOpen.startsWith("metadata") || !lineOpen.includes("{")) {
    fail(filePath, "expected metadata block: metadata {", openLineNo, colFromRaw(rawOpen));
  }
  if (!/^metadata\s*\{\s*$/.test(lineOpen)) {
    fail(filePath, "metadata block must be exactly 'metadata {' on its own line", openLineNo, colFromRaw(rawOpen));
  }

  const out: WorkflowMetadata = {};
  let idx = startIndex + 1;

  for (; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const line = raw.trim();

    if (!line) {
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    if (line === "}") {
      idx += 1;
      return { metadata: out, nextIndex: idx };
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      fail(filePath, `metadata line must be key = value: ${line}`, lineNo, colFromRaw(raw));
    }
    const key = line.slice(0, eq).trim();
    const valuePart = line.slice(eq + 1);

    if (!ALLOWED_KEYS.has(key)) {
      fail(
        filePath,
        `unknown metadata key: ${key}. Allowed: agent.default_model, agent.command, run.logs_dir, run.debug`,
        lineNo,
        colFromRaw(raw),
      );
    }

    const value = parseMetadataValue(filePath, raw, valuePart, lineNo);

    if (key === "agent.default_model") {
      if (typeof value !== "string") {
        fail(filePath, "agent.default_model must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.defaultModel = value;
    } else if (key === "agent.command") {
      if (typeof value !== "string") {
        fail(filePath, "agent.command must be a string", lineNo, colFromRaw(valuePart));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.command = value;
    } else if (key === "run.logs_dir") {
      if (typeof value !== "string") {
        fail(filePath, "run.logs_dir must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.run) {
        out.run = {};
      }
      out.run.logsDir = value;
    } else if (key === "run.debug") {
      if (typeof value !== "boolean") {
        fail(filePath, "run.debug must be true or false", lineNo, colFromRaw(raw));
      }
      if (!out.run) {
        out.run = {};
      }
      out.run.debug = value;
    }
  }

  fail(filePath, "metadata block not closed with '}'", startIndex + 1, 1);
}
