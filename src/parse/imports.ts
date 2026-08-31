import type { ImportDef, ScriptImportDef } from "../types";
import { fail, SINGLE_QUOTE_MESSAGE, stripQuotes } from "./core";
import { parseUseClauseKeys } from "./scripts";

function parsePathAlias(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
  pattern: RegExp,
  expected: string,
): { path: string; alias: string; loc: { line: number; col: number } } {
  const match = line.match(pattern);
  if (!match) {
    fail(filePath, expected, lineNo);
  }
  const pathRaw = match[1].trim();
  if (pathRaw.startsWith("'")) {
    fail(filePath, SINGLE_QUOTE_MESSAGE, lineNo);
  }
  return {
    path: stripQuotes(pathRaw),
    alias: match[2],
    loc: { line: lineNo, col: raw.indexOf("import") + 1 },
  };
}

export function parseImportLine(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
): ImportDef {
  return parsePathAlias(
    filePath,
    line,
    raw,
    lineNo,
    /^import\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/,
    'import must match: import "<path>" as <alias>',
  );
}

export function parseScriptImportLine(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
): ScriptImportDef {
  // `use KEY [KEY ...]` after the alias requests host keys for this script's
  // spawns, same clause as on a named script declaration.
  const useMatch = line.match(/^(.*\s+as\s+[A-Za-z_][A-Za-z0-9_]*)\s+use\s+(.+)$/);
  const aliasPart = useMatch ? useMatch[1] : line;
  const def = parsePathAlias(
    filePath,
    aliasPart,
    raw,
    lineNo,
    /^import\s+script\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/,
    'import script must match: import script "<path>" as <alias> [use KEY ...]',
  );
  if (def.alias === "use") {
    fail(filePath, `"use" is reserved and cannot be a script alias`, lineNo);
  }
  if (!useMatch) return def;
  return { ...def, use: parseUseClauseKeys(filePath, useMatch[2], lineNo) };
}
