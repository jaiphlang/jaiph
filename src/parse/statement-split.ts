/**
 * Split Jaiph lines on `;` so that `{ stm1 ; stm2 }` and `stm1 ; stm2` behave like
 * separate lines. Respects strings ("...", """..."""), parens, and brackets.
 * Brace depth is ignored for splitting so `echo { a; b }` stays one statement.
 */

/** If `s` is a single `{ ... }` pair, return inner content; otherwise null. */
export function stripOneOuterBracePair(s: string): string | null {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (i !== t.length - 1) return null;
        return t.slice(1, -1).trim();
      }
    }
  }
  return null;
}

/** Unwrap repeated `{ ... }` wrappers (Jaiph blocks). */
export function unwrapOuterBraceBlocks(line: string): string {
  let t = line.trim();
  for (;;) {
    const inner = stripOneOuterBracePair(t);
    if (inner === null) break;
    t = inner;
  }
  return t;
}

function couldStartRegexLiteralAt(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd();
  return before === "" || before.endsWith(";") || before.endsWith("=>");
}

/**
 * Split on `;` when not inside strings and when brace depth is 0 (so semicolons
 * inside `{ ... }` for shell / subshells do not split).
 * When `allowRegexLiteral` is true (match arms), `/…/` literals are not split on `;` inside the pattern.
 */
export function splitStatementsOnSemicolons(
  line: string,
  options?: { allowRegexLiteral?: boolean },
): string[] {
  const allowRegexLiteral = options?.allowRegexLiteral === true;
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inDoubleQuote = false;
  let inTripleQuote = false;
  let inRegex = false;

  while (i < line.length) {
    const ch = line[i];
    const next3 = line.slice(i, i + 3);

    if (inRegex) {
      current += ch;
      if (ch === "/" && line[i - 1] !== "\\") inRegex = false;
      i += 1;
      continue;
    }

    if (inTripleQuote) {
      if (next3 === '"""') {
        current += next3;
        inTripleQuote = false;
        i += 3;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"' && line[i - 1] !== "\\") inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (next3 === '"""') {
      inTripleQuote = true;
      current += next3;
      i += 3;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (
      allowRegexLiteral &&
      ch === "/" &&
      couldStartRegexLiteralAt(line, i)
    ) {
      inRegex = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "{") {
      braceDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }

    if (
      ch === ";" &&
      braceDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0
    ) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

/**
 * Expand a workflow/rule block line: unwrap Jaiph `{ ... }` wrappers, then split on `;`.
 */
export function expandBlockLineStatements(line: string): string[] {
  const unwrapped = unwrapOuterBraceBlocks(line);
  return splitStatementsOnSemicolons(unwrapped);
}

/** True if this line looks like a Jaiph step (not a generic shell line). */
function looksLikeJaiphStep(stmt: string): boolean {
  const t = stmt.trim();
  if (!t) return false;
  if (
    /^(run|ensure|prompt|const|fail|wait|log|logerr|return|match|if|export|channel|config)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*prompt\b/.test(t)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*run\b/.test(t)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*ensure\b/.test(t)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*<-/.test(t)) return true;
  if (/^run\s/.test(t)) return true;
  if (/^ensure\s/.test(t)) return true;
  if (/^run async\s/.test(t)) return true;
  return false;
}

/**
 * When semicolon-splitting would turn one shell line into several shell steps,
 * keep the original single line (e.g. `echo a; echo b`).
 */
export function shouldApplySemicolonStatementSplit(parts: string[]): boolean {
  if (parts.length <= 1) return false;
  const allLookShell = parts.every((p) => !looksLikeJaiphStep(p));
  return !allLookShell;
}

/**
 * Bash-style `if …; then` / `fi` lines must not be split on `;` (e.g. `if ensure; then`).
 */
export function shouldSkipSemicolonSplitForLine(line: string): boolean {
  const t = line.trim();
  if (/\bfi\b/.test(t)) return true;
  if (/;\s*then\b/.test(t)) return true;
  return false;
}

/**
 * Index of the `}` that closes the `{` at `openBraceIndex`, or -1.
 * Respects `"`, `"""`, `()`, `[]`, and nested `{}`.
 */
export function findClosingBraceIndex(s: string, openBraceIndex: number): number {
  let i = openBraceIndex;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inDoubleQuote = false;
  let inTripleQuote = false;

  while (i < s.length) {
    const ch = s[i];
    const next3 = s.slice(i, i + 3);

    if (inTripleQuote) {
      if (next3 === '"""') {
        inTripleQuote = false;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && s[i - 1] !== "\\") inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (next3 === '"""') {
      inTripleQuote = true;
      i += 3;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      i += 1;
      continue;
    }

    if (ch === "{") {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return i;
      i += 1;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth -= 1;
      i += 1;
      continue;
    }

    i += 1;
  }
  return -1;
}
