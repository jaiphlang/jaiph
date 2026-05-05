import type { ImportDef, ScriptImportDef } from "../types";
import { fail, stripQuotes } from "./core";

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
    fail(filePath, 'single-quoted strings are not supported; use double quotes ("...") instead', lineNo);
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
  return parsePathAlias(
    filePath,
    line,
    raw,
    lineNo,
    /^import\s+script\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/,
    'import script must match: import script "<path>" as <alias>',
  );
}
