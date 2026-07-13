/**
 * Whether the script body should use Jaiph bash rules (keyword guard, quote stripping, shell emit).
 * True when there is no custom shebang or the shebang runs bash.
 */
export function scriptShebangIsBash(shebang?: string): boolean {
  if (shebang === undefined) return true;
  const t = shebang.trim();
  if (t === "#!/usr/bin/env bash" || t === "#!/bin/bash" || t === "#!/usr/bin/bash") return true;
  if (/^#!\/usr\/bin\/env\s+bash(?:\s|$)/.test(t)) return true;
  return false;
}

/** The interpreter to spawn for a script, plus any leading interpreter flags. */
export type ScriptInterpreter = { command: string; prefixArgs: string[] };

/**
 * Resolve the interpreter a script should be executed with from its shebang
 * line, so the runtime can spawn `<interpreter> <scriptPath> <args...>`
 * explicitly rather than relying on the OS honoring the shebang or the file's
 * exec bit (Windows honors neither; `noexec` mounts break the exec bit too).
 *
 * Supported forms:
 *   `#!/usr/bin/env bash`        -> { command: "bash", prefixArgs: [] }
 *   `#!/usr/bin/env python3`     -> { command: "python3", prefixArgs: [] }
 *   `#!/bin/bash`                -> { command: "/bin/bash", prefixArgs: [] }
 *   `#!/usr/bin/env node --foo`  -> { command: "node", prefixArgs: ["--foo"] }
 *   `#!/usr/bin/env -S deno run` -> { command: "deno", prefixArgs: ["run"] }
 *
 * The interpreter is spawned by name so Node resolves it on PATH; a bare name
 * that names a missing interpreter surfaces as an ENOENT the caller can turn
 * into a diagnosable error. Returns null when the line is not a shebang.
 */
export function resolveInterpreterFromShebang(shebangLine: string): ScriptInterpreter | null {
  const t = shebangLine.trim();
  if (!t.startsWith("#!")) return null;
  const rest = t.slice(2).trim();
  if (rest === "") return null;
  const tokens = rest.split(/\s+/);
  const first = tokens[0]!;
  // `#!/usr/bin/env <interp> [args...]`: the real interpreter is the token
  // after `env` (skipping a leading `-S` split flag). Spawn it directly.
  if (first === "env" || first.endsWith("/env")) {
    let idx = 1;
    if (tokens[idx] === "-S") idx += 1;
    if (idx >= tokens.length) return null;
    return { command: tokens[idx]!, prefixArgs: tokens.slice(idx + 1) };
  }
  // `#!/absolute/path/interp [args...]`: spawn that path directly.
  return { command: first, prefixArgs: tokens.slice(1) };
}
