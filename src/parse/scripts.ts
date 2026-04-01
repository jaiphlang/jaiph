import type { ScriptDef } from "../types";
import { fail, indexOfClosingDoubleQuote } from "./core";
import { parseFencedBlock } from "./fence";

/**
 * Convert a fence language tag to a shebang line.
 * Any tag is valid — no hardcoded allowlist.
 */
export function langToShebang(lang: string): string {
  return `#!/usr/bin/env ${lang}`;
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
        'brace-style script bodies are no longer supported; use: script name = "..." or script name = ```...```',
        lineNo,
      );
    }
    if (/^script\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      const nameM = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `definitions must not use parentheses: script ${nameM?.[1] ?? "name"} = "..."`,
        lineNo,
      );
    }
    if (/^script\s+[A-Za-z_][A-Za-z0-9_]*/.test(line)) {
      const nameM = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `script definitions require = after the name: script ${nameM?.[1] ?? "name"} = "..."`,
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

  // Case 2: Quoted string — single-line, default runtime (shell)
  if (rhs.startsWith('"')) {
    const closeIdx = indexOfClosingDoubleQuote(rhs, 1);
    if (closeIdx === -1) {
      fail(filePath, "unterminated script body string", lineNo);
    }
    const body = rhs.slice(1, closeIdx).replace(/\\"/g, '"');
    const trailing = rhs.slice(closeIdx + 1).trim();
    if (trailing) {
      fail(filePath, `unexpected content after script body string: '${trailing}'`, lineNo);
    }
    return {
      scriptDef: {
        name: scriptName,
        comments: pendingComments,
        body,
        bodyKind: "string",
        loc: { line: lineNo, col: 1 },
      },
      nextIndex: startIndex + 1,
    };
  }

  // Case 3: Bare identifier — RHS is a binding whose string value is the script body
  const identMatch = rhs.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  if (identMatch) {
    return {
      scriptDef: {
        name: scriptName,
        comments: pendingComments,
        body: "", // resolved at compile time from envDecl
        bodyKind: "identifier",
        bodyIdentifier: identMatch[1],
        loc: { line: lineNo, col: 1 },
      },
      nextIndex: startIndex + 1,
    };
  }

  fail(
    filePath,
    'script body must be a quoted string, identifier, or fenced block: script name = "..." | script name = myVar | script name = ```...```',
    lineNo,
  );
}
