import type { ChannelDef, DefRef } from "../types";
import type { Token } from "./lexer";
import { fail, isRef } from "./core";
import { adjacent, isPunct, tokenizeLine } from "./body-cursor";

/** A route target: `name` or `alias.name`, written without spaces. */
function isRefTokens(piece: Token[]): boolean {
  if (piece.length === 1) return piece[0]!.kind === "ident";
  if (piece.length !== 3) return false;
  const [a, dot, b] = piece as [Token, Token, Token];
  return a.kind === "ident" && isPunct(dot, ".") && b.kind === "ident" && adjacent(a, dot) && adjacent(dot, b);
}

/** Split tokens at `,` punctuation. */
function splitAtCommas(toks: Token[]): Token[][] {
  const pieces: Token[][] = [[]];
  for (const tok of toks) {
    if (isPunct(tok, ",")) pieces.push([]);
    else pieces[pieces.length - 1]!.push(tok);
  }
  return pieces;
}

/**
 * `channel <name> [-> target1, target2, ...]` on line `raw`. Locations come
 * from the token positions of the name and each target.
 */
export function parseChannelLine(
  filePath: string,
  raw: string,
  lineNo: number,
  toks: Token[] = tokenizeLine(filePath, raw, lineNo),
): ChannelDef {
  const [kw, nameTok, arrow] = toks;
  const routed = isPunct(arrow, "->") && !adjacent(nameTok!, arrow!);
  if (
    kw?.text !== "channel" ||
    nameTok?.kind !== "ident" ||
    adjacent(kw, nameTok) ||
    (toks.length > 2 && !routed)
  ) {
    fail(
      filePath,
      'invalid channel declaration; expected: channel <name> or channel <name> -> <def>',
      lineNo,
      1,
    );
  }
  const name = nameTok.text;
  const loc = { line: lineNo, col: nameTok.col };
  if (!routed) {
    return { name, loc };
  }

  const targets = toks.slice(3);
  if (targets.length === 0) {
    fail(filePath, "channel route requires at least one target def after ->", lineNo, 1);
  }
  const pieces = splitAtCommas(targets);
  if (!pieces.every(isRefTokens)) {
    // Name the first malformed target as written between the commas.
    const text = raw.slice(arrow!.col + 1).trim();
    const bad = text.split(/\s*,\s*/).map((t) => t.trim()).find((t) => !t || !isRef(t)) ?? text;
    fail(filePath, `invalid def reference in channel route: "${bad}"`, lineNo, 1);
  }
  const routes: DefRef[] = pieces.map((piece) => {
    const value = piece.map((t) => t.text).join("");
    return { value, loc: { line: lineNo, col: piece[0]!.col } };
  });
  return { name, routes, loc };
}
