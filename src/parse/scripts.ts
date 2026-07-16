import type { ScriptDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseSingleBacktickBody } from "./core";
import { parseFencedScriptBlock } from "./fence";

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
  trivia: Trivia = createTrivia(),
): { scriptDef: ScriptDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  // Match: [export] script name = ...
  const match = line.match(/^(export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) {
    // Check for old brace syntax
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line)) {
      fail(
        filePath,
        "brace-style script bodies are no longer supported; use: script name = `...` or script name = ```...```",
        lineNo,
      );
    }
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      const nameM = line.match(/^(?:export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `definitions must not use parentheses: script ${nameM?.[1] ?? "name"} = \`...\``,
        lineNo,
      );
    }
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*/.test(line)) {
      const nameM = line.match(/^(?:export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `script definitions require = after the name: script ${nameM?.[1] ?? "name"} = \`...\``,
        lineNo,
      );
    }
    fail(filePath, "invalid script declaration", lineNo);
  }

  const isExported = Boolean(match[1]);
  const scriptName = match[2];
  const rhs = match[3].trimStart();

  // Case 1: Fenced block — opening ``` must be on the same line as script name =
  if (rhs.startsWith("```")) {
    const fenceLines = [...lines];
    fenceLines[startIndex] = rhs;
    const { body, lang, nextIdx, afterClose } = parseFencedScriptBlock(filePath, fenceLines, startIndex);

    if (afterClose.trim()) {
      fail(filePath, `unexpected content after closing fence: '${afterClose.trim()}'`, lineNo);
    }

    // Check for both fence tag and manual shebang
    if (lang && body.trimStart().startsWith("#!")) {
      fail(
        filePath,
        `fence tag "${lang}" already sets the shebang — remove the manual "#!" line`,
        lineNo,
      );
    }

    const scriptDef: ScriptDef = {
      name: scriptName,
      comments: pendingComments,
      body,
      ...(lang ? { lang } : {}),
      loc: { line: lineNo, col: 1 },
    };
    trivia.setNode(scriptDef, { scriptBodyKind: "fenced" });
    return {
      scriptDef,
      nextIndex: nextIdx,
      exported: isExported,
    };
  }

  // Case 2: Single backtick — inline one-line script body
  if (rhs.startsWith("`")) {
    const { body, restAfterClose } = parseSingleBacktickBody(rhs, filePath, lineNo, 1);
    const trailing = restAfterClose.trim();
    if (trailing) {
      fail(filePath, `unexpected content after script body backtick: '${trailing}'`, lineNo);
    }

    validateScriptBodyNoInterpolation(body, filePath, lineNo, 1);

    const scriptDef: ScriptDef = {
      name: scriptName,
      comments: pendingComments,
      body,
      loc: { line: lineNo, col: 1 },
    };
    trivia.setNode(scriptDef, { scriptBodyKind: "backtick" });
    return {
      scriptDef,
      nextIndex: startIndex + 1,
      exported: isExported,
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
