import type { WorkflowMetadata } from "../types";
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
  return fail(filePath, `config value must be a quoted string or true/false: ${trimmed}`, lineNo, col);
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
  if (!/^config\s*\{\s*$/.test(lineOpen)) {
    return fail(filePath, "config block must be exactly 'config {' on its own line", openLineNo, colFromRaw(rawOpen));
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
      return fail(filePath, `config line must be key = value: ${line}`, lineNo, colFromRaw(raw));
    }
    const key = line.slice(0, eq).trim();
    const valuePart = line.slice(eq + 1);

    if (!ALLOWED_KEYS.has(key)) {
      return fail(
        filePath,
        `unknown config key: ${key}. Allowed: agent.default_model, agent.command, agent.backend, agent.trusted_workspace, agent.cursor_flags, agent.claude_flags, run.logs_dir, run.debug`,
        lineNo,
        colFromRaw(raw),
      );
    }

    const value = parseMetadataValue(filePath, raw, valuePart, lineNo);

    if (key === "agent.default_model") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.default_model must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.defaultModel = value;
    } else if (key === "agent.command") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.command must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.command = value;
    } else if (key === "agent.backend") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.backend must be a string", lineNo, colFromRaw(raw));
      }
      const backend = value === "cursor" || value === "claude" ? value : undefined;
      if (!backend) {
        return fail(
          filePath,
          'agent.backend must be "cursor" or "claude"',
          lineNo,
          colFromRaw(raw),
        );
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.backend = backend;
    } else if (key === "agent.trusted_workspace") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.trusted_workspace must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.trustedWorkspace = value;
    } else if (key === "agent.cursor_flags") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.cursor_flags must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.cursorFlags = value;
    } else if (key === "agent.claude_flags") {
      if (typeof value !== "string") {
        return fail(filePath, "agent.claude_flags must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.agent) {
        out.agent = {};
      }
      out.agent.claudeFlags = value;
    } else if (key === "run.logs_dir") {
      if (typeof value !== "string") {
        return fail(filePath, "run.logs_dir must be a string", lineNo, colFromRaw(raw));
      }
      if (!out.run) {
        out.run = {};
      }
      out.run.logsDir = value;
    } else if (key === "run.debug") {
      if (typeof value !== "boolean") {
        return fail(filePath, "run.debug must be true or false", lineNo, colFromRaw(raw));
      }
      if (!out.run) {
        out.run = {};
      }
      out.run.debug = value;
    }
  }

  return fail(filePath, "config block not closed with '}'", startIndex + 1, 1);
}
