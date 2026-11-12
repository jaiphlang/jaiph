import type { ScriptDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import type { Token } from "./lexer";
import { fail } from "./core";
import { rejectRemovedOnelineBacktick, rejectRemovedScriptFence, rejectTagWithShebang, SCRIPT_FENCE } from "./fence";
import { BLOCK_OPENER, declHead, isPunct, keyOf, type BodyCursor } from "./body-cursor";
import { readFencedScript } from "./triple-quote";
import { ENV_KEY_RE, isReservedEnvKey } from "../env-reserved";

/** Re-exported for the public parser entry (match-arm inline-script check in validate). */
/** Re-exported for the public parser entry (validator, emitter, and runtime share it). */
export { parseCallRef, parseNestedCallArg, type NestedCallArg } from "./call-args";

/**
 * Parse the `use KEY [KEY …]` clause on a script declaration (named script or
 * `import script`). Identifiers only — no quotes, no `${…}`. Same reserved-key
 * contract as `--env`: the clause requests host keys, `--env` grants them.
 */
export function parseUseClauseKeys(
  filePath: string,
  clause: string,
  lineNo: number,
): string[] {
  const keys = clause.trim().split(/\s+/).filter((k) => k.length > 0);
  if (keys.length === 0) {
    fail(filePath, "use clause requires at least one environment variable name: use KEY [KEY ...]", lineNo);
  }
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      fail(
        filePath,
        `E_ENV_INVALID use key "${key}" is not a valid environment variable name (must match [A-Za-z_][A-Za-z0-9_]*)`,
        lineNo,
      );
    }
    if (isReservedEnvKey(key)) {
      fail(
        filePath,
        `E_ENV_RESERVED use cannot request reserved key "${key}" (same rule as --env); runtime-managed keys are off-limits`,
        lineNo,
      );
    }
  }
  return keys;
}

/**
 * Convert an interpreter tag (`python3'…'`) to a shebang line.
 * Any tag is valid — no hardcoded allowlist.
 */
export function langToShebang(lang: string): string {
  return `#!/usr/bin/env ${lang}`;
}

/** Shebang for an optional interpreter tag; `undefined` means the bash default. */
export function shebangForLang(lang: string | undefined): string | undefined {
  return lang ? langToShebang(lang) : undefined;
}

/**
 * Validate that a script body does not contain Jaiph `${identifier}` interpolation.
 * Scripts use shell `$1`, `$2` positional arguments only.
 *
 * Rejects simple `${identifier}` and `${identifier.field}` (Jaiph interpolation).
 * Allows bash parameter expansion: `${var:-default}`, `${#var}`, `${var%%pat}`, etc.
 */
export function validateScriptBodyNoInterpolation(
  body: string,
  filePath: string,
  lineNo: number,
  col: number,
): void {
  const name = findJaiphInterpolation(body);
  if (name !== null) {
    fail(filePath, jaiphInterpolationInScriptMessage(name), lineNo, col);
  }
}

/**
 * First Jaiph-style `${identifier}` / `${identifier.field}` in a one-line script
 * body, or null. Bash forms (`${var:-…}`, `${#var}`, `${var%%…}`) do not match.
 */
export function findJaiphInterpolation(body: string): string | null {
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/.exec(body);
  return m ? m[1] : null;
}

export function jaiphInterpolationInScriptMessage(name: string): string {
  return `script bodies cannot contain Jaiph interpolation (\${${name}}); use $1, $2 positional arguments instead`;
}

/**
 * The optional `use KEY …` clause and the `=` after a declaration's name or
 * parameter list, read from the line text at index `from`: the clause text
 * (up to the first `=`) and the index just past the `=`. Null when neither
 * `= …` nor `use … =` follows.
 */
export function useClauseAndEquals(raw: string, from: number): { use?: string; afterEq: number } | null {
  const m = /^(?:\s+use\s+([^=]+?))?\s*=/.exec(raw.slice(from));
  return m ? { ...(m[1] !== undefined ? { use: m[1] } : {}), afterEq: from + m[0].length } : null;
}

function failScriptHeader(filePath: string, toks: Token[], lineNo: number): never {
  const head = declHead(toks, "script");
  const name = keyOf(head?.name);
  if (!head || name === undefined) {
    fail(filePath, "invalid script declaration", lineNo);
  }
  const next = head.name.kind === "ident" ? toks[head.at + 2] : undefined;
  if (isPunct(next, "{")) {
    fail(
      filePath,
      `brace-style script bodies are no longer supported; use: script name = '...' or script name = ${SCRIPT_FENCE}...${SCRIPT_FENCE}`,
      lineNo,
    );
  }
  if (isPunct(next, "(")) {
    fail(filePath, `definitions must not use parentheses: script ${name} = '...'`, lineNo);
  }
  fail(filePath, `script definitions require = after the name: script ${name} = '...'`, lineNo);
}

/**
 * `[export] script name [use KEY …] = <body>` on line `startIndex` (module
 * level, or nested in a def body). The body is one `'…'` script token or a
 * `'''` block, either with an optional interpreter tag (`python3'…'`).
 */
export function parseScriptBlock(
  cursor: BodyCursor,
  at: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { scriptDef: ScriptDef; next: number; exported: boolean } {
  const filePath = cursor.filePath;
  const lineNo = cursor.lineNo(at);
  const raw = cursor.text(at);
  const toks = cursor.lineTokensOf(at);

  const head = declHead(toks, "script");
  const nameEnd = head ? head.name.col - 1 + head.name.text.length : 0;
  const eq = head?.name.kind === "ident" ? useClauseAndEquals(raw, nameEnd) : null;
  if (!head || !eq) {
    failScriptHeader(filePath, toks, lineNo);
  }

  const isExported = head.at === 1;
  const scriptName = head.name.text;
  if (scriptName === "use") {
    fail(filePath, `"use" is reserved and cannot be a script name`, lineNo);
  }
  const useKeys = eq.use !== undefined ? parseUseClauseKeys(filePath, eq.use, lineNo) : undefined;
  const afterEq = raw.slice(eq.afterEq);
  const rhs = afterEq.trim();
  const rhsStart = eq.afterEq + afterEq.length - afterEq.trimStart().length;
  const value = toks.filter((t) => t.col - 1 >= rhsStart);
  const first = value[0]?.col === rhsStart + 1 ? value[0] : undefined;

  rejectRemovedScriptFence(filePath, rhs, lineNo);
  rejectRemovedOnelineBacktick(filePath, rhs, lineNo);

  const make = (body: string, lang: string | undefined, kind: "fenced" | "oneline"): ScriptDef => {
    rejectTagWithShebang(filePath, lang, body, lineNo);
    const scriptDef: ScriptDef = {
      name: scriptName,
      comments: pendingComments,
      body,
      ...(lang ? { lang } : {}),
      ...(useKeys ? { use: useKeys } : {}),
      loc: { line: lineNo, col: 1 },
    };
    trivia.setNode(scriptDef, { scriptBodyKind: kind });
    return scriptDef;
  };

  // Case 1: Fenced block — opening ''' (after an optional tag) ends the line.
  const opener = first?.kind === "other" ? BLOCK_OPENER.exec(first.text) : null;
  if (opener && first!.text.endsWith(SCRIPT_FENCE)) {
    const lang = opener[1];
    const { body, next, afterClose } = readFencedScript(cursor, at, rhs.slice(lang?.length ?? 0));
    if (afterClose.trim()) {
      fail(filePath, `unexpected content after closing fence: '${afterClose.trim()}'`, lineNo);
    }
    return { scriptDef: make(body, lang, "fenced"), next, exported: isExported };
  }

  // Case 2: One-line single-quote script body
  if (first?.kind === "script_oneline") {
    const quote = first.text.indexOf("'");
    const body = first.text.slice(quote + 1, -1);
    const trailing = raw.slice(first.col - 1 + first.text.length).trim();
    if (trailing) {
      fail(filePath, `unexpected content after script body: '${trailing}'`, lineNo);
    }
    validateScriptBodyNoInterpolation(body, filePath, lineNo, 1);
    const lang = quote > 0 ? first.text.slice(0, quote) : undefined;
    return { scriptDef: make(body, lang, "oneline"), next: cursor.next(at), exported: isExported };
  }
  if (first?.kind === "other" && /^(?:[A-Za-z_][A-Za-z0-9_.-]*)?'$/.test(first.text)) {
    fail(filePath, "unterminated one-line script — missing closing '", lineNo, 1);
  }

  // Rejected: double-quoted string body
  if (rhs.startsWith('"')) {
    fail(
      filePath,
      `script bodies use single quotes: script ${scriptName} = '...'`,
      lineNo,
    );
  }

  const spacedTag = /^([A-Za-z_][A-Za-z0-9_.-]*)\s+'/.exec(rhs);
  if (spacedTag) {
    fail(
      filePath,
      `interpreter tag must touch the opening quote: script ${scriptName} = ${spacedTag[1]}'...' (no space)`,
      lineNo,
    );
  }

  // Rejected: bare identifier body
  if (first?.kind === "ident" && value.length === 1) {
    fail(
      filePath,
      `script bodies must be a one-liner or fenced block: script ${scriptName} = '...' or script ${scriptName} = ${SCRIPT_FENCE}...${SCRIPT_FENCE}`,
      lineNo,
    );
  }

  fail(
    filePath,
    `script body must be a one-liner or fenced block: script ${scriptName} = '...' or script ${scriptName} = ${SCRIPT_FENCE}...${SCRIPT_FENCE}`,
    lineNo,
  );
}
