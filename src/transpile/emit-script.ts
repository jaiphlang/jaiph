import { inlineScriptName, nestedScriptName } from "../inline-script-name";
import type { Expr, jaiphModule, ScriptDef, ScriptImportDef, StepDef } from "../types";
import { scriptShebangIsBash, langToShebang } from "../parser";

/**
 * Replace `alias.name` patterns in shell commands with
 * the fully-qualified symbol (`symbol::name`) used in generated script bodies.
 */
export function resolveShellRefs(
  command: string,
  importedModuleSymbols: Map<string, string>,
): string {
  for (const [alias, symbol] of importedModuleSymbols) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`,
      "g",
    );
    command = command.replace(pattern, `${symbol}::$1`);
  }
  return command;
}

/** Bash requires no space around = in local/export/readonly. */
export function normalizeShellLocalExport(command: string): string {
  return command.replace(
    /\b(local|export|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)\s+=\s+/g,
    "$1 $2=",
  );
}

function emitScriptBodyLine(cmd: string, importedModuleSymbols: Map<string, string>): string {
  const t = cmd.trim();
  if (/^\s*return\s*$/.test(t)) {
    return "return $?";
  }
  const ret = t.match(/^return\s+(.+)$/s);
  if (ret) {
    const arg = ret[1].trim();
    const isBashExitCode =
      /^[0-9]+$/.test(arg) ||
      arg === "$?" ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(arg);
    if (isBashExitCode) {
      return t.replace(/^\s*return\s+/, "return ");
    }
  }
  return normalizeShellLocalExport(resolveShellRefs(cmd, importedModuleSymbols));
}

function wrapBashStandaloneScriptBody(body: string, envPreamble: string): string {
  const preamble = envPreamble ? `${envPreamble}\n` : "";
  if (!body.trim()) {
    return ["set -euo pipefail", "__jaiph_script_entry() {", preamble, "}", '__jaiph_script_entry "$@"'].join(
      "\n",
    );
  }
  // Do not indent body lines inside the function: prefixing each line with spaces
  // corrupts multiline double-quoted strings and here-doc-style continuations.
  return [
    "set -euo pipefail",
    "__jaiph_script_entry() {",
    preamble,
    body,
    "}",
    '__jaiph_script_entry "$@"',
  ].join("\n");
}

export type ScriptArtifact = { name: string; content: string };

/** Walk all `Expr` nodes carried by a step and yield inline-script bodies. */
function emitInlineFromExpr(expr: Expr, seen: Set<string>, out: ScriptArtifact[]): void {
  if (expr.kind === "inline_script") {
    const shebang = expr.lang ? langToShebang(expr.lang) : undefined;
    emitInlineScriptArtifact(expr.body, shebang, seen, out);
  }
}

/** Collect all inline script bodies from a step tree (handles if/for/catch/recover nesting). */
function collectInlineScripts(
  steps: StepDef[],
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  for (const s of steps) {
    if (s.type === "exec") {
      emitInlineFromExpr(s.body, seen, out);
      if (s.catch) {
        const recoverSteps = "single" in s.catch ? [s.catch.single] : s.catch.block;
        collectInlineScripts(recoverSteps, seen, out);
      }
      if (s.recover) {
        const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
        collectInlineScripts(recoverSteps, seen, out);
      }
      continue;
    }
    if (s.type === "const") {
      emitInlineFromExpr(s.value, seen, out);
      continue;
    }
    if (s.type === "return") {
      emitInlineFromExpr(s.value, seen, out);
      continue;
    }
    if (s.type === "say") {
      emitInlineFromExpr(s.message, seen, out);
      continue;
    }
    if (s.type === "send") {
      emitInlineFromExpr(s.value, seen, out);
      continue;
    }
    if (s.type === "local_decl" && s.decl.kind === "def") {
      collectInlineScripts(s.decl.def.steps, seen, out);
      continue;
    }
    if (s.type === "if") {
      collectInlineScripts(s.body, seen, out);
      if (s.elseBody) collectInlineScripts(s.elseBody, seen, out);
      continue;
    }
    if (s.type === "for_lines") {
      collectInlineScripts(s.body, seen, out);
    }
  }
}

/** Build one script artifact (module-level or nested) with a caller-chosen file name. */
function buildOneScriptArtifact(
  sc: ScriptDef,
  importedModuleSymbols: Map<string, string>,
  name: string,
): ScriptArtifact {
  const { shebang, cleanBody } = resolveScriptShebang(sc.body, sc.lang);
  const isBash = scriptShebangIsBash(shebang === "#!/usr/bin/env bash" ? undefined : shebang);
  const processedBody = isBash
    ? cleanBody.split("\n").map((c) => emitScriptBodyLine(c, importedModuleSymbols)).join("\n")
    : cleanBody;
  const body = isBash ? wrapBashStandaloneScriptBody(processedBody, "") : processedBody;
  const content = body.length > 0 ? `${shebang}\n${body}\n` : `${shebang}\n`;
  return { name, content };
}

/**
 * Collect nested (def-local) `script` declarations from a step tree, emitting
 * each under its deterministic {@link nestedScriptName}. Recurses into nested
 * def bodies and every control-flow / recovery body so a script declared at any
 * depth is emitted.
 */
function collectNestedScripts(
  steps: StepDef[],
  importedModuleSymbols: Map<string, string>,
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  for (const s of steps) {
    if (s.type === "local_decl") {
      if (s.decl.kind === "script") {
        const sc = s.decl.script;
        const name = nestedScriptName(sc.name, sc.body, sc.lang, sc.use);
        if (!seen.has(name)) {
          seen.add(name);
          out.push(buildOneScriptArtifact(sc, importedModuleSymbols, name));
        }
      } else if (s.decl.kind === "def") {
        collectNestedScripts(s.decl.def.steps, importedModuleSymbols, seen, out);
      }
      continue;
    }
    if (s.type === "exec") {
      if (s.catch) {
        collectNestedScripts("single" in s.catch ? [s.catch.single] : s.catch.block, importedModuleSymbols, seen, out);
      }
      if (s.recover) {
        collectNestedScripts("single" in s.recover ? [s.recover.single] : s.recover.block, importedModuleSymbols, seen, out);
      }
      continue;
    }
    if (s.type === "if") {
      collectNestedScripts(s.body, importedModuleSymbols, seen, out);
      if (s.elseBody) collectNestedScripts(s.elseBody, importedModuleSymbols, seen, out);
      continue;
    }
    if (s.type === "for_lines") {
      collectNestedScripts(s.body, importedModuleSymbols, seen, out);
    }
  }
}

function emitInlineScriptArtifact(
  body: string,
  shebang: string | undefined,
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  const name = inlineScriptName(body, shebang);
  if (seen.has(name)) return;
  seen.add(name);
  const resolvedShebang = shebang ?? "#!/usr/bin/env bash";
  const isBash = scriptShebangIsBash(shebang);
  // Inline script body uses \n as newline escape in the DSL string
  const expandedBody = body.replace(/\\n/g, "\n");
  const wrapped = isBash ? wrapBashStandaloneScriptBody(expandedBody, "") : expandedBody;
  const content = wrapped.length > 0 ? `${resolvedShebang}\n${wrapped}\n` : `${resolvedShebang}\n`;
  out.push({ name, content });
}

/** Resolve shebang for a script: from lang tag, manual #! in body, or default bash. */
function resolveScriptShebang(body: string, lang?: string): { shebang: string; cleanBody: string } {
  if (lang) {
    return { shebang: langToShebang(lang), cleanBody: body };
  }
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("#!")) {
    const rest = body.slice(body.indexOf("\n") + 1);
    return { shebang: firstLine, cleanBody: body.indexOf("\n") === -1 ? "" : rest };
  }
  return { shebang: "#!/usr/bin/env bash", cleanBody: body };
}

export function buildScriptFiles(
  ast: jaiphModule,
  importedModuleSymbols: Map<string, string>,
  _defSymbol: string,
  resolvedScriptImports?: Map<string, string>,
): ScriptArtifact[] {
  const out: ScriptArtifact[] = [];

  // Emit imported script files verbatim (they are complete executables with shebangs).
  if (resolvedScriptImports) {
    for (const [name, content] of resolvedScriptImports) {
      const normalized = content.endsWith("\n") ? content : content + "\n";
      out.push({ name, content: normalized });
    }
  }

  for (const sc of ast.scripts) {
    out.push(buildOneScriptArtifact(sc, importedModuleSymbols, sc.name));
  }

  // Emit inline script artifacts and nested (def-local) scripts from def steps.
  const seen = new Set<string>();
  for (const w of ast.defs) collectInlineScripts(w.steps, seen, out);
  const nestedSeen = new Set<string>();
  for (const w of ast.defs) collectNestedScripts(w.steps, importedModuleSymbols, nestedSeen, out);

  return out;
}
