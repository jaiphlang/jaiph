import type { DefMetadata } from "../types";
import type { Trivia, ConfigBodyPart } from "./trivia";
import type { Token } from "./lexer";
import { isPunct, type BodyCursor } from "./body-cursor";
import {
  fail,
  isBareIdentifier,
  isJaiphInterpolationRef,
  SINGLE_QUOTE_MESSAGE,
  decodeQuotedInner,
  rejectRemovedEscapes,
} from "./core";
import { validateJaiphStringContent } from "./validate-string-content";

const CONFIG_INTERPOLATION_RE = /\$\{[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?\}/;

/** True when a config string value contains `${name}` or `${name.field}` interpolation. */
export function configValueHasInterpolation(value: string): boolean {
  return CONFIG_INTERPOLATION_RE.test(value);
}

const ALLOWED_KEYS = new Set([
  "agent.model",
  "agent.command",
  "agent.backend",
  "agent.trusted_workspace",
  "agent.cursor_flags",
  "agent.claude_flags",
  "run.logs_dir",
  "run.debug",
  "run.recover_limit",
  "module.name",
  "module.version",
  "module.description",
]);

/** Expected value type for each key that needs type validation. */
const KEY_TYPES: Record<string, "string" | "boolean" | "number"> = {
  "agent.model": "string",
  "agent.command": "string",
  "agent.backend": "string",
  "agent.trusted_workspace": "string",
  "agent.cursor_flags": "string",
  "agent.claude_flags": "string",
  "run.logs_dir": "string",
  "run.debug": "boolean",
  "run.recover_limit": "number",
  "module.name": "string",
  "module.version": "string",
  "module.description": "string",
};

/**
 * A config value: the tokens after the `=` and the same text, trimmed. A
 * string value is the text between its outer quotes, with `\"` the only
 * escape.
 */
function parseMetadataValue(
  filePath: string,
  value: Token[],
  text: string,
  lineNo: number,
  col: number,
): string | boolean | number {
  const only = value.length === 1 ? value[0] : undefined;
  if (only?.kind === "ident" && (only.text === "true" || only.text === "false")) {
    return only.text === "true";
  }
  if (only?.kind === "number") {
    return Number(only.text);
  }
  if (value[0]?.text.startsWith(`'`)) {
    return fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo, col);
  }
  if (value[0]?.kind === "string") {
    // A string value is exactly one `"…"` token, optionally followed by a comment.
    const next = value[1];
    if (next && !(next.kind === "other" && next.text === "#")) {
      const comment = value.slice(1).find((t) => t.kind === "other" && t.text === "#");
      const end = comment ? comment.col - value[0].col : text.length;
      const extra = text.slice(next.col - value[0].col, end).trim();
      return fail(filePath, `unexpected content after config value: '${extra}'`, lineNo, next.col);
    }
    const inner = value[0].text.slice(1, -1);
    rejectRemovedEscapes(filePath, inner, "config", lineNo, col);
    const content = decodeQuotedInner(inner);
    if (configValueHasInterpolation(content)) {
      validateJaiphStringContent(content, filePath, lineNo, col, "config");
    }
    return content;
  }
  if (only?.kind === "ident" && isBareIdentifier(only.text)) {
    return `\${${only.text}}`;
  }
  if (isJaiphInterpolationRef(text)) {
    validateJaiphStringContent(text, filePath, lineNo, col, "config");
    return text;
  }
  return fail(
    filePath,
    `config value must be a quoted string, bare identifier, or true/false: ${text}`,
    lineNo,
    col,
  );
}

function validateKeyType(
  filePath: string,
  key: string,
  value: string | boolean | number,
  lineNo: number,
  col: number,
): void {
  const expected = KEY_TYPES[key];
  if (!expected) return;

  if (expected === "string" && typeof value !== "string") {
    return fail(filePath, `${key} must be a string`, lineNo, col);
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    return fail(filePath, `${key} must be true or false`, lineNo, col);
  }
  if (expected === "number" && typeof value !== "number") {
    return fail(filePath, `${key} must be an integer`, lineNo, col);
  }
}

type ConfigValue = string | boolean | number;

const KEY_SETTERS: Record<string, (out: DefMetadata, value: ConfigValue) => void> = {
  "agent.model": (m, v) => ((m.agent ??= {}).model = v as string),
  "agent.command": (m, v) => ((m.agent ??= {}).command = v as string),
  "agent.trusted_workspace": (m, v) => ((m.agent ??= {}).trustedWorkspace = v as string),
  "agent.cursor_flags": (m, v) => ((m.agent ??= {}).cursorFlags = v as string),
  "agent.claude_flags": (m, v) => ((m.agent ??= {}).claudeFlags = v as string),
  "run.logs_dir": (m, v) => ((m.run ??= {}).logsDir = v as string),
  "run.debug": (m, v) => ((m.run ??= {}).debug = v as boolean),
  "run.recover_limit": (m, v) => ((m.run ??= {}).recoverLimit = v as number),
  "module.name": (m, v) => ((m.module ??= {}).name = v as string),
  "module.version": (m, v) => ((m.module ??= {}).version = v as string),
  "module.description": (m, v) => ((m.module ??= {}).description = v as string),
};

function assignConfigKey(
  filePath: string,
  out: DefMetadata,
  key: string,
  value: ConfigValue,
  lineNo: number,
  col: number,
): void {
  validateKeyType(filePath, key, value, lineNo, col);
  if (key === "agent.backend") {
    if (
      typeof value === "string" &&
      !configValueHasInterpolation(value) &&
      value !== "cursor" &&
      value !== "claude" &&
      value !== "codex"
    ) {
      fail(filePath, 'agent.backend must be "cursor", "claude", or "codex"', lineNo, col);
    }
    (out.agent ??= {}).backend = value as "cursor" | "claude" | "codex";
    return;
  }
  KEY_SETTERS[key]?.(out, value);
}

/** `config { … }` opening on the line at `at`: the metadata and the position after its `}` line. */
export function parseConfigBlock(
  cursor: BodyCursor,
  at: number,
  trivia?: Trivia,
): { metadata: DefMetadata; next: number } {
  const filePath = cursor.filePath;
  const openNo = cursor.lineNo(at);
  const open = cursor.lineTokensOf(at);
  if (open.length !== 2 || open[0]!.text !== "config" || !isPunct(open[1], "{")) {
    return fail(filePath, "config block must be exactly 'config {' on its own line", openNo, open[0]?.col ?? 1);
  }

  const out: DefMetadata = {};
  const bodySequence: ConfigBodyPart[] = [];
  for (let pos = cursor.next(at); !cursor.atEnd(pos); pos = cursor.next(pos)) {
    const lineNo = cursor.lineNo(pos);
    const raw = cursor.text(pos);
    const toks = cursor.lineTokensOf(pos);
    const head = toks[0];
    if (!head) {
      continue;
    }
    if (head.kind === "other" && head.text === "#") {
      bodySequence.push({ kind: "comment", text: raw.trim() });
      continue;
    }
    if (toks.length === 1 && isPunct(head, "}")) {
      if (bodySequence.length > 0 && trivia) {
        trivia.setNode(out, { configBodySequence: bodySequence });
      }
      return { metadata: out, next: cursor.next(pos) };
    }

    // `key = value`: the key is the text before the first `=`.
    const eqAt = toks.findIndex((t) => t.text.includes("="));
    if (eqAt === -1) {
      return fail(filePath, `config line must be key = value: ${raw.trim()}`, lineNo, head.col);
    }
    const eqTok = toks[eqAt]!;
    const eq = eqTok.col - 1 + eqTok.text.indexOf("=");
    const key = raw.slice(0, eq).trim();
    if (!ALLOWED_KEYS.has(key)) {
      return fail(
        filePath,
        `unknown config key: ${key}. Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
        lineNo,
        head.col,
      );
    }

    const text = raw.slice(eq + 1).trim();
    const valueToks = eqTok.text === "=" ? toks.slice(eqAt + 1) : [];
    const value = parseMetadataValue(filePath, valueToks, text, lineNo, head.col);
    const bareSource = typeof value === "string" && !text.startsWith('"') ? text : undefined;
    bodySequence.push({ kind: "assign", key, ...(bareSource !== undefined ? { bareSource } : {}) });
    assignConfigKey(filePath, out, key, value, lineNo, head.col);
  }

  return fail(filePath, "config block not closed with '}'", openNo, 1);
}
