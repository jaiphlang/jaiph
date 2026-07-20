import type { Arg } from "../types";
import { fail, isBareIdentifier, isBareDottedIdentifier, isRef, parseCallRef } from "./core";
import { dedentTripleQuotedBody, parseTripleQuoteBlock, tripleQuoteBodyToRaw } from "./triple-quote";

function pushArgFromSegment(out: Arg[], segment: string): void {
  const trimmed = segment.trim();
  if (!trimmed) return;
  if (isBareIdentifier(trimmed) || isBareDottedIdentifier(trimmed)) {
    out.push({ kind: "var", name: trimmed });
    return;
  }
  out.push({ kind: "literal", raw: trimmed });
}

/**
 * Collect call arguments for a managed call whose `(` is on `openLineIdx` and may
 * span multiple source lines. `textAfterOpenParen` is the text on the opening line
 * after `(`. Triple-quoted blocks (`"""…"""`) must start as the first non-whitespace
 * token on their line and are stored as `{ kind: "literal", raw }` with the body
 * dedented to the common margin.
 *
 * The formatter normalises triple-quoted call args to inline double-quoted strings
 * (intentional: `Arg` objects do not carry trivia, so the round-trip form is the
 * dedented inline `"…"` value).
 *
 * Calls `fail()` (E_PARSE) when:
 * - The matching `)` is not found before end of file.
 * - A triple-quoted block is malformed (delegated to `parseTripleQuoteBlock`).
 * - There is unexpected text immediately before a triple-quoted block on the same line.
 */
export function parseMultilineCallArgList(
  filePath: string,
  lines: string[],
  openLineIdx: number,
  textAfterOpenParen: string,
): { args: Arg[]; nextLineIdx: number; rest: string } {
  const args: Arg[] = [];
  let pendingText = "";
  let parenDepth = 1;
  let inDoubleQuote = false;
  let lineIdx = openLineIdx;
  let toScan = textAfterOpenParen;

  while (true) {
    let i = 0;
    while (i < toScan.length) {
      const ch = toScan[i];
      if (inDoubleQuote) {
        pendingText += ch;
        if (ch === '"' && toScan[i - 1] !== "\\") inDoubleQuote = false;
        i++;
        continue;
      }
      if (ch === '"') { inDoubleQuote = true; pendingText += ch; i++; continue; }
      if (ch === "(") { parenDepth++; pendingText += ch; i++; continue; }
      if (ch === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          pushArgFromSegment(args, pendingText);
          return { args, nextLineIdx: lineIdx + 1, rest: toScan.slice(i + 1) };
        }
        pendingText += ch; i++; continue;
      }
      if (ch === "," && parenDepth === 1) {
        pushArgFromSegment(args, pendingText);
        pendingText = "";
        i++;
        continue;
      }
      pendingText += ch;
      i++;
    }

    // Advance to the next source line.
    lineIdx++;
    if (lineIdx >= lines.length) {
      fail(filePath, 'unterminated multiline call — missing closing ")"', openLineIdx + 1);
    }

    const nextLine = lines[lineIdx];
    const trimmedNextLine = nextLine.trim();

    // Triple-quoted block: recognised only when `"""` is the first non-whitespace
    // token on the line (consistent with every other triple-quoted position).
    if (!inDoubleQuote && trimmedNextLine.startsWith('"""')) {
      if (pendingText.trim()) {
        fail(filePath, "unexpected content before triple-quoted call argument", lineIdx + 1);
      }
      const { body, nextIdx, afterClose } = parseTripleQuoteBlock(filePath, lines, lineIdx);
      const raw = tripleQuoteBodyToRaw(dedentTripleQuotedBody(body));
      args.push({ kind: "literal", raw });
      pendingText = "";
      // nextIdx points to the line after the closing `"""`.
      // Set lineIdx to the closing `"""` line; the outer loop will toScan = afterClose
      // and on the next iteration will do lineIdx++ → nextIdx.
      lineIdx = nextIdx - 1;
      toScan = afterClose;
      continue;
    }

    toScan = nextLine;
  }
}

/**
 * Parse a call reference `ref(args)` that may span multiple source lines.
 *
 * Single-line calls are handled via `parseCallRef` (fast path).
 * When `(` is not closed on line `idx`, subsequent lines are consumed via
 * `parseMultilineCallArgList` until the matching `)` is found.
 *
 * Returns `null` when `s` does not start with a valid `ref(` pattern (e.g., bare
 * identifier with no `(`). Calls `fail()` (E_PARSE) when `s` starts with `ref(` but
 * the call cannot be completed — this is the guard against incomplete managed-call
 * forms silently becoming shell steps.
 */
export function parseCallRefMultiline(
  filePath: string,
  lines: string[],
  idx: number,
  s: string,
): { ref: string; args?: Arg[]; rest: string; nextLineIdx: number } | null {
  const t = s.trimStart();

  // Fast path: single-line call.
  const singleLine = parseCallRef(t);
  if (singleLine) {
    return {
      ref: singleLine.ref,
      ...(singleLine.args ? { args: singleLine.args } : {}),
      rest: singleLine.rest,
      nextLineIdx: idx + 1,
    };
  }

  // Multiline path: `s` must start with a valid ref name followed by `(`.
  // If it does but the call is incomplete, we call fail() — never return null.
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\((.*)/s);
  if (!m || !isRef(m[1])) return null;

  const ref = m[1];
  const textAfterOpen = m[2];
  const { args, nextLineIdx, rest } = parseMultilineCallArgList(filePath, lines, idx, textAfterOpen);
  return { ref, ...(args.length > 0 ? { args } : {}), rest, nextLineIdx };
}
