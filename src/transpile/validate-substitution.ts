/**
 * Scan shell-like text for bash command substitutions $(...) and validate
 * their contents do not invoke Jaiph symbols or channel/route forms.
 */

import { jaiphError } from "../errors";

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

export type SymbolKind = "rule" | "workflow" | "function";

export type SubstitutionValidateEnv = {
  filePath: string;
  loc: { line: number; col: number };
  localRules: Set<string>;
  localWorkflows: Set<string>;
  localFunctions: Set<string>;
  importsByAlias: Map<string, string>;
  lookupImported: (alias: string, name: string) => SymbolKind | undefined;
};

function stripLeadingEnvAssigns(segment: string): string {
  let s = segment.trim();
  for (;;) {
    const m = s.match(
      /^([A-Za-z_][A-Za-z0-9_]*)=(?:[^\s'"$]+|"[^"]*"|'[^']*')\s+/,
    );
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/** First command word in a simple shell segment (split on | && || ; newline). */
function firstCommandWord(segment: string): string {
  const parts = segment.split(/(?:\|\||&&|\||;|\n)/);
  for (const raw of parts) {
    let s = stripLeadingEnvAssigns(raw);
    if (!s) continue;
    while (s.startsWith("(") || s.startsWith("{")) {
      s = s.slice(1).trim();
    }
    if (!s) continue;
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
    return m ? m[1] : "";
  }
  return "";
}

function hasSendOperatorOutsideQuotes(s: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length - 1; i += 1) {
    const ch = s[i];
    if (ch === "\\" && inDouble) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "<" && s[i + 1] === "-") {
      return true;
    }
  }
  return false;
}

function throwJaiphInSubstitution(env: SubstitutionValidateEnv, message: string): never {
  throw jaiphError(env.filePath, env.loc.line, env.loc.col, "E_VALIDATE", message);
}

function classifyRefToken(
  token: string,
  env: SubstitutionValidateEnv,
): SymbolKind | "unknown" | "none" {
  if (!token || token === "echo" || token === "printf") return "none";
  const parts = token.split(".");
  if (parts.length === 2) {
    const [alias, name] = parts;
    if (!env.importsByAlias.has(alias)) {
      return "none";
    }
    const kind = env.lookupImported(alias, name);
    return kind === undefined ? "unknown" : kind;
  }
  if (parts.length === 1) {
    const name = parts[0];
    if (env.localRules.has(name)) return "rule";
    if (env.localWorkflows.has(name)) return "workflow";
    if (env.localFunctions.has(name)) return "function";
  }
  return "none";
}

export type SubstitutionValidationMode = "substitution" | "managed_shell";

/**
 * Validate one $(...) inner, or a managed shell fragment (workflow line / send RHS).
 * Nested $(...) always uses substitution wording.
 */
export function validateSubstitutionInner(
  inner: string,
  env: SubstitutionValidateEnv,
  mode: SubstitutionValidationMode = "substitution",
): void {
  const trimmed = inner.trim();
  if (/^(?:run|ensure)\s/.test(trimmed)) {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? 'workflow shell cannot use "run" or "ensure" as shell commands; use Jaiph step forms instead'
        : 'command substitution cannot use Jaiph keywords "run" or "ensure"; use managed steps outside $(...)',
    );
  }
  if (hasSendOperatorOutsideQuotes(inner)) {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? "channel send (<-) must be a dedicated send step, not embedded in shell"
        : "command substitution cannot contain channel send (<-); use a workflow send step instead",
    );
  }
  const word = firstCommandWord(inner);
  const cls = classifyRefToken(word, env);
  if (cls === "rule") {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? `rule "${word}" must be invoked with ensure, not as a shell command`
        : `command substitution cannot invoke rule "${word}"; use ensure ${word} ... in a workflow step`,
    );
  }
  if (cls === "workflow") {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? `workflow "${word}" must be invoked with run, not as a shell command`
        : `command substitution cannot invoke workflow "${word}"; use run ${word} ... in a workflow step`,
    );
  }
  if (cls === "function") {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? `direct function call "${word}" is not allowed in a workflow; use: run ${word} ...`
        : `command substitution cannot invoke function "${word}"; use run ${word} ... for managed calls (or use pure shell inside $(...))`,
    );
  }
  if (cls === "unknown") {
    throwJaiphInSubstitution(
      env,
      mode === "managed_shell"
        ? `unknown imported symbol "${word}" used as a shell command`
        : `command substitution references unknown imported symbol "${word}"`,
    );
  }

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

