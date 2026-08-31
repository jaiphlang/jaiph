import type { Diagnostics } from "../diagnostics";
import { isJaiphInterpolationRef } from "../parser";
import type { Arg, jaiphModule } from "../types";
import {
  lookupKind,
  validateRef,
  DEF_REF_EXPECT,
  type RefExpectMessages,
  type RefResolutionContext,
  type RefTargetKind,
} from "./validate-ref-resolution";
import type { SubstitutionValidateEnv } from "./validate-substitution";
import {
  extractDotFieldRefs,
  extractInlineCaptures,
  stripDoubleQuotes,
} from "./validate-string";
import type { ValidatorCtx } from "./validate-step-ctx";

// Shared call-shape, channel/route, inline-capture, and small string helpers
// used by both the step dispatcher (`validate-step.ts`) and the expression
// validators (`validate-expr.ts`). Split out of `validate-step.ts` to keep each
// file under the analyzability line cap.

// -- Channel/route helpers --------------------------------------------------

export function validateChannelRef(channel: string, loc: { line: number; col: number }, ctx: ValidatorCtx): void {
  const parts = channel.split(".");
  if (parts.length === 1) {
    if (!ctx.localChannels.has(channel)) {
      ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
    }
    return;
  }
  if (parts.length !== 2) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
  const [alias, importedChannel] = parts;
  const importedFile = ctx.importsByAlias.get(alias);
  if (!importedFile) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
  const importedAst = ctx.importedAstCache.get(importedFile)!;
  const importedChannels = new Set(importedAst.channels.map((c) => c.name));
  if (!importedChannels.has(importedChannel)) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
}

export const ROUTE_REF_EXPECT: RefExpectMessages = DEF_REF_EXPECT;

export function resolveRouteTargetParams(
  ref: string,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): number | undefined {
  const dotIdx = ref.indexOf(".");
  if (dotIdx >= 0) {
    const alias = ref.slice(0, dotIdx);
    const name = ref.slice(dotIdx + 1);
    const importPath = refCtx.importsByAlias.get(alias);
    if (!importPath) return undefined;
    const importedAst = refCtx.importedAstCache.get(importPath);
    if (!importedAst) return undefined;
    const wf = importedAst.defs.find((w) => w.name === name);
    return wf?.params.length;
  }
  const wf = ast.defs.find((w) => w.name === ref);
  return wf?.params.length;
}

// -- Inline string captures / dot-field refs --------------------------------

export function validateInlineStringCaptures(
  content: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  for (const cap of extractInlineCaptures(content)) {
    validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "run", cap.args);
    validateRef({ value: cap.ref, loc }, ctx.ast, ctx.refCtx, {
      mode: "expect",
      expect: ctx.scope.runRefExpect,
    });
  }
}

export function validateDotFieldRefs(
  content: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  for (const ref of extractDotFieldRefs(content)) {
    validateDotFieldRef(ref.varName, ref.fieldName, loc, ctx);
  }
}

/**
 * Validate a dot-notation `if` / `match` subject like `r.verdict`. Emits the
 * same `E_VALIDATE` diagnostics as `${var.field}` interpolation when the base
 * is not a typed prompt capture or the field is not in its `returns` schema.
 * Non-dot subjects (single identifier) are accepted without further checks
 * to preserve prior behavior.
 */
export function validateDotSubject(
  subject: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  const dotIdx = subject.indexOf(".");
  if (dotIdx === -1) return;
  const varName = subject.slice(0, dotIdx);
  const fieldName = subject.slice(dotIdx + 1);
  validateDotFieldRef(varName, fieldName, loc, ctx);
}

export function validateDotFieldRef(
  varName: string,
  fieldName: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  const fields = ctx.promptSchemas.get(varName);
  if (!fields) {
    ctx.diag.error(
      ctx.ast.filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `\${${varName}.${fieldName}}: "${varName}" is not a typed prompt capture; dot notation requires a prompt with "returns" schema`,
    );
    return;
  }
  if (!fields.includes(fieldName)) {
    ctx.diag.error(
      ctx.ast.filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `\${${varName}.${fieldName}}: field "${fieldName}" is not defined in the returns schema for "${varName}"; available fields: ${fields.join(", ")}`,
    );
  }
}

// -- Shared call-shape helpers ----------------------------------------------

function hasShellRedirection(args: Arg[] | undefined): boolean {
  if (!args) return false;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    let inQuote = false;
    const raw = a.raw;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && (i === 0 || raw[i - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && (ch === ">" || ch === "|" || ch === "&")) {
        return true;
      }
    }
  }
  return false;
}

export function validateNoShellRedirection(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  keyword: string,
  args: Arg[] | undefined,
): void {
  if (!hasShellRedirection(args)) return;
  diag.error(
    filePath,
    loc.line,
    loc.col,
    "E_VALIDATE",
    `shell redirection (>, >>, |, &) is not supported with ${keyword}; use a script block for shell operations`,
  );
}

export function validateNestedManagedCallArgs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    checkNestedManagedInLiteral(diag, filePath, loc, a.raw);
  }
}

function checkNestedManagedInLiteral(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  raw: string,
): void {
  const stripped = stripQuotedSegmentContent(raw);
  const re = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, match.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested managed calls in argument position must be explicit; use "run ${match[1]}(...)" inside the argument list`,
    );
  }
  const btRe = /`[^`]*`\s*\(/g;
  let btMatch: RegExpExecArray | null;
  while ((btMatch = btRe.exec(stripped)) !== null) {
    const before = stripped.slice(0, btMatch.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested inline script calls in argument position must be explicit; use "run \`...\`(...)" inside the argument list`,
    );
  }
}

function stripQuotedSegmentContent(segment: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote && segment[i - 1] !== "\\") {
        quote = null;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

export function validateArgVarRefs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
  knownVars: Set<string>,
  recoverBindings: Set<string> | undefined,
  ctx: ValidatorCtx,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind === "literal") {
      // Unquoted `${…}` is only valid inside strings. Call args must use bare
      // identifiers / bare IDENT.IDENT (or a quoted string that embeds ${…}).
      if (isJaiphInterpolationRef(a.raw)) {
        const bare = a.raw.slice(2, -1); // strip ${ }
        diag.error(
          filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `call arguments cannot use unquoted interpolation ${a.raw}; use bare ${bare.includes(".") ? "field access" : "identifier"}: ...(${bare})`,
        );
        continue;
      }
      // Quoted strings may embed `${var.field}` — validate those fields.
      validateDotFieldRefs(a.raw, loc, ctx);
      continue;
    }
    const dotIdx = a.name.indexOf(".");
    if (dotIdx >= 0) {
      // Bare IDENT.IDENT — typed-prompt field access; runtime expands via ${base.field}.
      validateDotFieldRef(a.name.slice(0, dotIdx), a.name.slice(dotIdx + 1), loc, ctx);
      continue;
    }
    if (recoverBindings?.has(a.name)) continue;
    if (knownVars.has(a.name)) continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `unknown identifier "${a.name}" used as bare argument; declare it with "const", use a capture, or add a def parameter`,
    );
  }
}

export function validateArity(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  ref: string,
  args: Arg[] | undefined,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): void {
  const params = lookupCalleeParams(ref, ast, refCtx);
  if (params === undefined) return;
  const argCount = args?.length ?? 0;
  if (argCount !== params.length) {
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `def "${ref}" expects ${params.length} argument(s) (${params.join(", ") || "none"}), but got ${argCount}`,
    );
  }
}

function lookupCalleeParams(
  ref: string,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): string[] | undefined {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const name = parts[0];
    const wf = ast.defs.find((w) => w.name === name);
    return wf?.params;
  }
  if (parts.length === 2) {
    const [alias, name] = parts;
    const importedFile = refCtx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = refCtx.importedAstCache.get(importedFile);
    if (!importedAst) return undefined;
    const wf = importedAst.defs.find((w) => w.name === name);
    return wf?.params;
  }
  return undefined;
}

// -- Misc small helpers -----------------------------------------------------

/** Resolve a named prompt's `PromptDef` (local or imported) for schema / param lookup. */
export function resolvePromptDef(
  ref: string,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): { params: string[]; returns?: string } | undefined {
  const parts = ref.split(".");
  if (parts.length === 1) {
    return ast.prompts?.find((p) => p.name === parts[0]);
  }
  if (parts.length === 2) {
    const [alias, name] = parts;
    const importedFile = refCtx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = refCtx.importedAstCache.get(importedFile);
    return importedAst?.prompts?.find((p) => p.name === name);
  }
  return undefined;
}

export function extractConstScriptName(rhs: string): string | undefined {
  const trimmed = rhs.trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return trimmed;
  const inner = stripDoubleQuotes(trimmed);
  const m = inner.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
  return m?.[1];
}

export function promptBareIdentifier(raw: string): string | undefined {
  const m = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
  return m?.[1];
}

export function parseSchemaFieldNames(rawSchema: string): string[] {
  const inner = rawSchema.trim().replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (!inner) return [];
  const names: string[] = [];
  for (const part of inner.split(",")) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S+\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

export function makeImportedKindLookup(
  ctx: ValidatorCtx,
): (alias: string, name: string) => RefTargetKind | undefined {
  return (alias, name) => {
    const importedFile = ctx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = ctx.importedAstCache.get(importedFile)!;
    return lookupKind(importedAst, name);
  };
}

export function makeSubEnv(
  ctx: ValidatorCtx,
  loc: { line: number; col: number },
): SubstitutionValidateEnv {
  return {
    filePath: ctx.ast.filePath,
    loc,
    localDefs: ctx.localDefs,
    localScripts: ctx.localScripts,
    importsByAlias: ctx.importsByAlias,
    lookupImported: (alias, name) => {
      const k = makeImportedKindLookup(ctx)(alias, name);
      return k === "def" || k === "script" ? k : undefined;
    },
  };
}
