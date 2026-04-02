import type { ScriptDef } from "../types";
import { fail } from "./core";
import { parseFencedBlock } from "./fence";

/**
 * Convert a fence language tag to a shebang line.
 * Any tag is valid — no hardcoded allowlist.
 */
export function langToShebang(lang: string): string {
  return `#!/usr/bin/env ${lang}`;
}

/**
 * Validate that a script body does not contain Jaiph `${identifier}` interpolation.
 * Scripts use shell `$1`, `$2` positional arguments only.
 *
 * Rejects simple `${identifier}` and `${identifier.field}` (Jaiph interpolation).
 * Allows bash parameter expansion: `${var:-default}`, `${#var}`, `${var%%pat}`, etc.
 */
export function validateScriptBodyNoInterpolation(
  body: string,
  filePath: string,
  lineNo: number,
  col: number,
): void {
  // Match ${identifier} or ${identifier.identifier} — simple Jaiph interpolation
  // but NOT bash forms like ${var:-...}, ${var:+...}, ${var%%...}, ${var//...}, ${#var}, ${!var}, ${var:N:M}
  const jaiphInterp = /\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/;
  const m = jaiphInterp.exec(body);
  if (m) {
    fail(
      filePath,
      `script bodies cannot contain Jaiph interpolation (\${${m[1]}}); use $1, $2 positional arguments instead`,
      lineNo,
      col,
    );
  }
}

export function parseScriptBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { scriptDef: ScriptDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  // Reject old script:lang syntax
  if (/^script:/.test(line)) {
    fail(
      filePath,
      "script:lang syntax is no longer supported; use a fenced block with a lang tag: script name = ```lang",
      lineNo,
    );
  }

  // Match: script name = ...
  const match = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) {
    // Check for old brace syntax
    if (/^script\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line)) {
      fail(
        filePath,
        "brace-style script bodies are no longer supported; use: script name = `...` or script name = ```...```",
        lineNo,
      );
    }
    if (/^script\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      const nameM = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `definitions must not use parentheses: script ${nameM?.[1] ?? "name"} = \`...\``,
        lineNo,
      );
    }
    if (/^script\s+[A-Za-z_][A-Za-z0-9_]*/.test(line)) {
      const nameM = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `script definitions require = after the name: script ${nameM?.[1] ?? "name"} = \`...\``,
        lineNo,
      );
    }
    fail(filePath, "invalid script declaration", lineNo);
  }

  const scriptName = match[1];
  const rhs = match[2].trimStart();

  // Case 1: Fenced block — opening ``` must be on the same line as script name =
  if (rhs.startsWith("```")) {
    const fenceLines = [...lines];
    fenceLines[startIndex] = rhs;
    const { body, lang, nextIdx, returns } = parseFencedBlock(filePath, fenceLines, startIndex);

    if (returns) {
      fail(filePath, 'script definitions do not support "returns" on the closing fence', lineNo);
    }

    // Check for both fence tag and manual shebang
    if (lang && body.trimStart().startsWith("#!")) {
      fail(
        filePath,
        `fence tag "${lang}" already sets the shebang — remove the manual "#!" line`,
        lineNo,
      );
    }

    validateScriptBodyNoInterpolation(body, filePath, lineNo, 1);

    return {
      scriptDef: {
        name: scriptName,
        comments: pendingComments,
        body,
        ...(lang ? { lang } : {}),
        bodyKind: "fenced",
        loc: { line: lineNo, col: 1 },
      },
      nextIndex: nextIdx,
    };
  }

  // Case 2: Single backtick — inline one-line script body
  if (rhs.startsWith("`")) {
    const closeIdx = rhs.indexOf("`", 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated inline script backtick — missing closing `", lineNo);
    }
    const body = rhs.slice(1, closeIdx);
    if (body.includes("\n")) {
      fail(filePath, "single backtick script body must be one line — use triple backtick for multiline", lineNo);
    }
    const trailing = rhs.slice(closeIdx + 1).trim();
    if (trailing) {
      fail(filePath, `unexpected content after script body backtick: '${trailing}'`, lineNo);
    }

    validateScriptBodyNoInterpolation(body, filePath, lineNo, 1);

    return {
      scriptDef: {
        name: scriptName,
        comments: pendingComments,
        body,
        bodyKind: "backtick",
        loc: { line: lineNo, col: 1 },
      },
      nextIndex: startIndex + 1,
    };
  }

  // Rejected: double-quoted string body
  if (rhs.startsWith('"')) {
    fail(
      filePath,
      `script bodies use backticks: script ${scriptName} = \`...\``,
      lineNo,
    );
  }

  // Rejected: bare identifier body
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs)) {
    fail(
      filePath,
      `script bodies must be backtick or fenced block: script ${scriptName} = \`...\` or script ${scriptName} = \`\`\`...\`\`\``,
      lineNo,
    );
  }

  fail(
    filePath,
    `script body must be a backtick or fenced block: script ${scriptName} = \`...\` or script ${scriptName} = \`\`\`...\`\`\``,
    lineNo,
  );
}
