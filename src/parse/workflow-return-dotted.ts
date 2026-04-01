/**
 * Bare `base.field` in `return base.field` is sugar for `return "${base.field}"`
 * (same interpolation as in double-quoted strings).
 */
const BARE_DOTTED_RETURN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isBareDottedIdentifierReturn(expr: string): boolean {
  return BARE_DOTTED_RETURN_RE.test(expr.trim());
}

export function dottedReturnToQuotedString(expr: string): string {
  const t = expr.trim();
  const inner = "$" + "{" + t + "}";
  return '"' + inner + '"';
}
