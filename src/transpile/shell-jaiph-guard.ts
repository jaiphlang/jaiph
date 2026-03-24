/**
 * Keyword-first Jaiph invocations: managed shell and $(...) bodies must not use
 * bare REF tokens where `ensure` / `run` is required. Single place for symbol
 * classification used by substitution scanning and workflow shell lines.
 */

import { jaiphError } from "../errors";

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

export type SubstitutionValidationMode = "substitution" | "managed_shell";

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
 * If `token` is a Jaiph REF naming a rule, workflow, function, or unknown
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
    if (env.localRules.has(name)) return "rule";
    if (env.localWorkflows.has(name)) return "workflow";
    if (env.localFunctions.has(name)) return "function";
  }
  return "none";
}

/**
 * Reject Jaiph symbol used as shell command word; shared by $(...) and
 * workflow managed shell lines (keyword-first: use ensure / run).
 */
export function assertKeywordFirstShellFragment(
  inner: string,
  env: SubstitutionValidateEnv,
  mode: SubstitutionValidationMode,
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
  const cls = classifyJaiphShellRefToken(word, env);
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
}
