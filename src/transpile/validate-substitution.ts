/**
 * Scan shell-like text for bash command substitutions $(...) and validate
 * their contents do not invoke Jaiph symbols or channel/route forms.
 */

import {
  assertKeywordFirstShellFragment,
  type SubstitutionValidateEnv,
  type SubstitutionValidationMode,
} from "./shell-jaiph-guard";

export type { SubstitutionValidateEnv, SubstitutionValidationMode } from "./shell-jaiph-guard";

/** Skip `$(` at index i (i points at '$'); returns index after closing ')'. */
function skipCommandSubstitution(s: string, dollarIdx: number): { end: number; inner: string } {
  if (s[dollarIdx] !== "$" || s[dollarIdx + 1] !== "(") {
    throw new Error("skipCommandSubstitution: expected $('");
  }
  // Arithmetic $(( ... ))
  if (s[dollarIdx + 2] === "(") {
    let j = dollarIdx + 3;
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (c === "\\" && inDouble) {
        j += 2;
        continue;
      }
      if (c === "'" && !inDouble) {
        inSingle = !inSingle;
        j += 1;
        continue;
      }
      if (c === '"' && !inSingle) {
        inDouble = !inDouble;
        j += 1;
        continue;
      }
      if (!inSingle && !inDouble) {
        if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
      }
      j += 1;
    }
    return { end: j, inner: "" };
  }

  const innerStart = dollarIdx + 2;
  let j = innerStart;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (c === "\\" && inDouble) {
      j += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      j += 1;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      j += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
    }
    j += 1;
  }
  return { end: j, inner: s.slice(innerStart, j - 1) };
}

export function forEachCommandSubstitution(
  s: string,
  visit: (inner: string, dollarIdx: number) => void,
): void {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && inDouble) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    // Bash still runs $(...) inside double quotes; only single quotes disable it.
    if (!inSingle && ch === "$" && s[i + 1] === "(") {
      const { end, inner } = skipCommandSubstitution(s, i);
      if (inner.length > 0) {
        visit(inner, i);
      }
      i = end;
      continue;
    }
    i += 1;
  }
}

/**
 * Validate one $(...) inner, or a managed shell fragment (workflow line / send RHS).
 * Nested $(...) always uses substitution wording.
 */
export function validateSubstitutionInner(
  inner: string,
  env: SubstitutionValidateEnv,
  mode: SubstitutionValidationMode = "substitution",
): void {
  assertKeywordFirstShellFragment(inner, env, mode);
  forEachCommandSubstitution(inner, (nested) => {
    validateSubstitutionInner(nested, env, "substitution");
  });
}

/** Scan a shell fragment for forbidden $(...) content. */
export function validateNoJaiphCommandSubstitution(
  command: string,
  env: SubstitutionValidateEnv,
): void {
  forEachCommandSubstitution(command, (inner) => {
    validateSubstitutionInner(inner, env);
  });
}

/** Send RHS / workflow shell line: same symbol rules as $(...), migration-friendly errors. */
export function validateManagedShellFragment(text: string, env: SubstitutionValidateEnv): void {
  validateSubstitutionInner(text, env, "managed_shell");
}
