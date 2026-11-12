import type { ScriptDef } from "../types";
import { createTrivia, type Trivia } from "./trivia";
import { fail, parseSingleQuoteScriptBody } from "./core";
import {
  parseFencedScriptBlock,
  rejectRemovedOnelineBacktick,
  rejectRemovedScriptFence,
  rejectTagWithShebang,
  SCRIPT_FENCE,
  splitScriptLangPrefix,
  startsScriptFence,
} from "./fence";
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

export function parseScriptBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
  trivia: Trivia = createTrivia(),
): { scriptDef: ScriptDef; nextIndex: number; exported: boolean } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  // Match: [export] script name [use KEY ...] = ...
  const match = line.match(/^(export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+use\s+([^=]+?))?\s*=\s*(.*)$/);
  if (!match) {
    // Check for old brace syntax
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line)) {
      fail(
        filePath,
        `brace-style script bodies are no longer supported; use: script name = '...' or script name = ${SCRIPT_FENCE}...${SCRIPT_FENCE}`,
        lineNo,
      );
    }
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      const nameM = line.match(/^(?:export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `definitions must not use parentheses: script ${nameM?.[1] ?? "name"} = '...'`,
        lineNo,
      );
    }
    if (/^(export\s+)?script\s+[A-Za-z_][A-Za-z0-9_]*/.test(line)) {
      const nameM = line.match(/^(?:export\s+)?script\s+([A-Za-z_][A-Za-z0-9_]*)/);
      fail(
        filePath,
        `script definitions require = after the name: script ${nameM?.[1] ?? "name"} = '...'`,
        lineNo,
      );
    }
    fail(filePath, "invalid script declaration", lineNo);
  }

  const isExported = Boolean(match[1]);
  const scriptName = match[2];
  if (scriptName === "use") {
    fail(filePath, `"use" is reserved and cannot be a script name`, lineNo);
  }
  const useKeys = match[3] !== undefined ? parseUseClauseKeys(filePath, match[3], lineNo) : undefined;
  const rhsRaw = match[4].trimStart();

  rejectRemovedScriptFence(filePath, rhsRaw, lineNo);
  rejectRemovedOnelineBacktick(filePath, rhsRaw, lineNo);

  // Optional interpreter tag directly before the opening quote: python3'…' / node'''…'''
  const { lang, rest: rhs } = splitScriptLangPrefix(rhsRaw);

  // Case 1: Fenced block — opening ''' must be on the same line as script name =
  if (startsScriptFence(rhs)) {
    const fenceLines = [...lines];
    fenceLines[startIndex] = rhs;
    const { body, nextIdx, afterClose } = parseFencedScriptBlock(filePath, fenceLines, startIndex);

    if (afterClose.trim()) {
      fail(filePath, `unexpected content after closing fence: '${afterClose.trim()}'`, lineNo);
    }

    rejectTagWithShebang(filePath, lang, body, lineNo);

    const scriptDef: ScriptDef = {
      name: scriptName,
      comments: pendingComments,
      body,
      ...(lang ? { lang } : {}),
      ...(useKeys ? { use: useKeys } : {}),
      loc: { line: lineNo, col: 1 },
    };
    trivia.setNode(scriptDef, { scriptBodyKind: "fenced" });
    return {
      scriptDef,
      nextIndex: nextIdx,
      exported: isExported,
    };
  }

  // Case 2: One-line single-quote script body
  if (rhs.startsWith("'")) {
    const { body, restAfterClose } = parseSingleQuoteScriptBody(rhs, filePath, lineNo, 1);
    const trailing = restAfterClose.trim();
    if (trailing) {
      fail(filePath, `unexpected content after script body: '${trailing}'`, lineNo);
    }

    validateScriptBodyNoInterpolation(body, filePath, lineNo, 1);
    rejectTagWithShebang(filePath, lang, body, lineNo);

    const scriptDef: ScriptDef = {
      name: scriptName,
      comments: pendingComments,
      body,
      ...(lang ? { lang } : {}),
      ...(useKeys ? { use: useKeys } : {}),
      loc: { line: lineNo, col: 1 },
    };
    trivia.setNode(scriptDef, { scriptBodyKind: "oneline" });
    return {
      scriptDef,
      nextIndex: startIndex + 1,
      exported: isExported,
    };
  }

  // Rejected: double-quoted string body
  if (rhs.startsWith('"')) {
    fail(
      filePath,
      `script bodies use single quotes: script ${scriptName} = '...'`,
      lineNo,
    );
  }

  if (lang) {
    fail(filePath, `expected ' or ${SCRIPT_FENCE} directly after interpreter tag "${lang}"`, lineNo);
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
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs)) {
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
