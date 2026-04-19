/**
 * Keyword-first checks for Jaiph symbols inside bash `$(...)` and at the start of
 * workflow shell lines.
 */

import { jaiphError } from "../errors";

export type SymbolKind = "workflow" | "script";

export type SubstitutionValidateEnv = {
  filePath: string;
  loc: { line: number; col: number };
  localWorkflows: Set<string>;
  localScripts: Set<string>;
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

/**
 * If `token` is a Jaiph REF naming a rule, workflow, script, or unknown
 * import, return its kind; otherwise "none" (ordinary shell / echo / printf).
 */
export function classifyJaiphShellRefToken(
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
    if (env.localWorkflows.has(name)) return "workflow";
    if (env.localScripts.has(name)) return "script";
  }
  return "none";
}

/**
 * Reject Jaiph symbol used as the command word inside `$(...)` (script bodies).
 */
export function assertKeywordFirstShellFragment(inner: string, env: SubstitutionValidateEnv): void {
  const trimmed = inner.trim();
  if (/^run\s/.test(trimmed)) {
    throwJaiphInSubstitution(
      env,
      'command substitution cannot use Jaiph keyword "run"; use managed steps outside $(...)',
    );
  }
  if (hasSendOperatorOutsideQuotes(inner)) {
    throwJaiphInSubstitution(
      env,
      "command substitution cannot contain channel send (<-); use a workflow send step instead",
    );
  }
  const word = firstCommandWord(inner);
  const cls = classifyJaiphShellRefToken(word, env);
  if (cls === "workflow") {
    throwJaiphInSubstitution(
      env,
      `command substitution cannot invoke workflow "${word}"; use run ${word} ... in a workflow step`,
    );
  }
  if (cls === "script") {
    throwJaiphInSubstitution(
      env,
      `command substitution cannot invoke script "${word}"; use run ${word} ... for managed calls (or use pure shell inside $(...))`,
    );
  }
  if (cls === "unknown") {
    throwJaiphInSubstitution(
      env,
      `command substitution references unknown imported symbol "${word}"`,
    );
  }
}

/** Reject Jaiph workflow/script used as the first command word of a shell line. */
export function assertNoJaiphLeadCommandWord(fragment: string, env: SubstitutionValidateEnv): void {
  const trimmed = fragment.trim();
  if (/^run\s/.test(trimmed)) {
    throwJaiphInSubstitution(
      env,
      'workflow shell cannot use Jaiph keyword "run" as the shell command; use managed steps',
    );
  }
  const word = firstCommandWord(trimmed);
  const cls = classifyJaiphShellRefToken(word, env);
  if (cls === "workflow") {
    throwJaiphInSubstitution(
      env,
      `workflow "${word}" must be called with run, not as a shell command`,
    );
  }
  if (cls === "script") {
    throwJaiphInSubstitution(
      env,
      `direct script call "${word}"; use run ${word} ... instead`,
    );
  }
  if (cls === "unknown") {
    throwJaiphInSubstitution(
      env,
      `shell line references unknown imported symbol "${word}"`,
    );
  }
}
