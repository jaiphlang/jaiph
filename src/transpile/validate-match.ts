import type { Diagnostics } from "../diagnostics";
import { canonicalizeTripleQuotedString } from "../parser";
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
    const bodyTrimmed = (arm.tripleQuotedBody ? canonicalizeTripleQuotedString(arm.body) : arm.body).trimStart();
    if (/^return(\s|$)/.test(bodyTrimmed)) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>`,
      );
    }
    if (/`[^`]*`\s*\(/.test(bodyTrimmed) || bodyTrimmed.startsWith("```")) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `inline scripts are not allowed in match arm bodies; use a named script with "run script_name(…)" instead`,
      );
    }
    if (!arm.tripleQuotedBody) {
      const idMatch = bodyTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (idMatch) {
        const ident = idMatch[1]!;
        const after = bodyTrimmed.slice(ident.length);
        const startsCall = after.startsWith("(");
        const startsArgs = /^\s+\S/.test(after);
        if ((startsCall || startsArgs) && ident !== "fail" && ident !== "run" && ident !== "ensure") {
          const hint = ident === "error" ? ` did you mean "fail"?` : "";
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown match arm verb "${ident}"; allowed: fail "...", run ref(...), ensure ref(...).${hint}`,
          );
        }
        if (!startsCall && !startsArgs && after.trim() === "" && !knownVars.has(ident)) {
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown identifier "${ident}" in match arm body; declare it with "const", use a capture, or add a parameter`,
          );
        }
      }
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
