/**
 * Bare `name` or `name.field` in `return <expr>` is sugar for `return "${expr}"`
 * (same interpolation as in double-quoted strings).
 */
import { isBareDottedIdentifier } from "./core";

const BARE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isBareDottedIdentifierReturn(expr: string): boolean {
  return isBareDottedIdentifier(expr.trim());
}

export function isBareIdentifierReturn(expr: string): boolean {
  return BARE_RE.test(expr.trim());
}

export function dottedReturnToQuotedString(expr: string): string {
  return `"\${${expr.trim()}}"`;
}

export function bareIdentifierToQuotedString(expr: string): string {
  return `"\${${expr.trim()}}"`;
}
