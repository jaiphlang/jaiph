import type { ImportDef } from "../types";
import { fail, stripQuotes } from "./core";

export function parseImportLine(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
): ImportDef {
  const match = line.match(/^import\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) {
    fail(filePath, 'import must match: import "<path>" as <alias>', lineNo);
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
