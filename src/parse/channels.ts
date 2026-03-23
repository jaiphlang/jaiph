import type { ChannelDef } from "../types";
import { fail } from "./core";

export function parseChannelLine(
  filePath: string,
  line: string,
  raw: string,
  lineNo: number,
): ChannelDef {
  const match = line.match(/^channel\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) {
    fail(
      filePath,
      'invalid channel declaration; expected exactly: channel <name>',
      lineNo,
      1,
    );
  }
  const name = match[1];
  return {
    name,
    loc: { line: lineNo, col: raw.indexOf(name) + 1 },
  };
}
