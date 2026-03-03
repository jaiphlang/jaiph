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
  return {
    path: stripQuotes(match[1]),
    alias: match[2],
    loc: { line: lineNo, col: raw.indexOf("import") + 1 },
  };
}
