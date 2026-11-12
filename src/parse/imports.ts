import type { ImportDef, ScriptImportDef } from "../types";
import type { Token } from "./lexer";
import { fail, SINGLE_QUOTE_MESSAGE, stripQuotes } from "./core";
import { adjacent, tokenizeLine } from "./body-cursor";
import { parseUseClauseKeys } from "./scripts";

/** True when `tok` is the identifier `text`. */
function isWord(tok: Token | undefined, text: string): boolean {
  return tok?.kind === "ident" && tok.text === text;
}

/**
 * `<path> as <alias>` in `toks[from..end)`, after the keyword token
 * `toks[from - 1]`. The alias is the last token and `as` the one before it,
 * each set off by whitespace; the path is the line text between the keyword
 * and `as`, written as anything (a `"…"` string in practice).
 */
function parsePathAlias(
  filePath: string,
  raw: string,
  lineNo: number,
  toks: Token[],
  from: number,
  end: number,
  expected: string,
): { path: string; alias: string; loc: { line: number; col: number } } {
  const kw = toks[from - 1]!;
  const alias = toks[end - 1];
  const as = toks[end - 2];
  const pathStart = kw.col - 1 + kw.text.length;
  const between = as ? raw.slice(pathStart, as.col - 1) : "";
  if (
    end - 2 < from ||
    alias?.kind !== "ident" ||
    !isWord(as, "as") ||
    adjacent(as!, alias) ||
    between.length < 3 ||
    !/^\s[^]*\s$/.test(between)
  ) {
    fail(filePath, expected, lineNo);
  }
  const pathRaw = between.trim();
  if (pathRaw.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  }
  return {
    path: stripQuotes(pathRaw),
    alias: alias.text,
    loc: { line: lineNo, col: toks[0]!.col },
  };
}

/** `import "<path>" as <alias>` on line `raw`. */
export function parseImportLine(
  filePath: string,
  raw: string,
  lineNo: number,
  toks: Token[] = tokenizeLine(filePath, raw, lineNo),
): ImportDef {
  return parsePathAlias(filePath, raw, lineNo, toks, 1, toks.length, 'import must match: import "<path>" as <alias>');
}

/**
 * The `use` token of a trailing `as <alias> use KEY …` clause: the last
 * `as <ident> use <more>` run, each part set off by whitespace.
 */
function useClauseIndex(toks: Token[]): number {
  for (let u = toks.length - 2; u >= 3; u -= 1) {
    const [as, alias, use, next] = [toks[u - 2]!, toks[u - 1]!, toks[u]!, toks[u + 1]!];
    if (
      isWord(use, "use") &&
      alias.kind === "ident" &&
      isWord(as, "as") &&
      !adjacent(toks[u - 3]!, as) &&
      !adjacent(as, alias) &&
      !adjacent(alias, use) &&
      !adjacent(use, next)
    ) {
      return u;
    }
  }
  return -1;
}

/** `import script "<path>" as <alias> [use KEY …]` on line `raw`. */
export function parseScriptImportLine(
  filePath: string,
  raw: string,
  lineNo: number,
  toks: Token[] = tokenizeLine(filePath, raw, lineNo),
): ScriptImportDef {
  // `use KEY [KEY ...]` after the alias requests host keys for this script's
  // spawns, same clause as on a named script declaration.
  const u = useClauseIndex(toks);
  const def = parsePathAlias(
    filePath,
    raw,
    lineNo,
    toks,
    2,
    u === -1 ? toks.length : u,
    'import script must match: import script "<path>" as <alias> [use KEY ...]',
  );
  if (def.alias === "use") {
    fail(filePath, `"use" is reserved and cannot be a script alias`, lineNo);
  }
  if (u === -1) return def;
  const useTok = toks[u]!;
  return { ...def, use: parseUseClauseKeys(filePath, raw.slice(useTok.col - 1 + useTok.text.length), lineNo) };
}
