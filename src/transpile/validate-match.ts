import type { Diagnostics } from "../diagnostics";
import type { MatchExprDef, MatchPatternDef } from "../types";

/** All regex sources in a pattern, descending into alternation alternands. */
function collectRegexSources(pattern: MatchPatternDef): string[] {
  if (pattern.kind === "regex") return [pattern.source];
  if (pattern.kind === "alternation") return pattern.patterns.flatMap(collectRegexSources);
  return [];
}

export function validateMatchExpr(
  diag: Diagnostics,
  filePath: string,
  expr: MatchExprDef,
  knownVars: Set<string>,
): void {
  if (expr.arms.length === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have at least one arm");
  }
  let wildcardCount = 0;
  for (const arm of expr.arms) {
    if (arm.pattern.kind === "wildcard") wildcardCount += 1;
    for (const source of collectRegexSources(arm.pattern)) {
      try {
        new RegExp(source);
      } catch {
        diag.error(
          filePath,
          expr.loc.line,
          expr.loc.col,
          "E_VALIDATE",
          `invalid regex in match pattern: /${source}/`,
        );
      }
    }
    // The parser has already classified and grammar-checked the arm body; only
    // the bare-identifier scope check remains here (callee resolution and arity
    // for `call` arms run through `validateCallable` in validate-expr.ts).
    if (arm.body.kind === "var" && !knownVars.has(arm.body.name)) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `unknown identifier "${arm.body.name}" in match arm body; declare it with "const", use a capture, or add a parameter`,
      );
    }
  }
  if (wildcardCount === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm");
  }
  if (wildcardCount > 1) {
    diag.error(
      filePath,
      expr.loc.line,
      expr.loc.col,
      "E_VALIDATE",
      "match must have exactly one wildcard (_) arm, found multiple",
    );
  }
}
