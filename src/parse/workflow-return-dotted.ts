/**
 * Bare `name` or `name.field` in `return <expr>` is sugar for `return "${expr}"`
 * (same interpolation as in double-quoted strings).
 */
const BARE_DOTTED_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/;
const BARE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isBareDottedIdentifierReturn(expr: string): boolean {
  return BARE_DOTTED_RE.test(expr.trim());
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
