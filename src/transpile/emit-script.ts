import { inlineScriptName } from "../inline-script-name";
import type { jaiphModule, ScriptImportDef, WorkflowStepDef } from "../types";
import { scriptShebangIsBash } from "../parse/script-bash";
import { langToShebang } from "../parse/scripts";

/**
 * Replace `alias.name` patterns in shell commands with
 * the fully-qualified symbol (`symbol::name`) used in generated script bodies.
 */
export function resolveShellRefs(
  command: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  for (const [alias, symbol] of importedWorkflowSymbols) {
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

function emitScriptBodyLine(cmd: string, importedWorkflowSymbols: Map<string, string>): string {
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
  return normalizeShellLocalExport(resolveShellRefs(cmd, importedWorkflowSymbols));
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

/** Collect all inline script steps from a step tree (handles if/else/catch nesting). */
function collectInlineScripts(
  steps: WorkflowStepDef[],
  seen: Set<string>,
  out: ScriptArtifact[],
): void {
  for (const s of steps) {
    if (s.type === "run_inline_script") {
      const shebang = s.lang ? langToShebang(s.lang) : undefined;
      emitInlineScriptArtifact(s.body, shebang, seen, out);
    } else if (s.type === "const" && s.value.kind === "run_inline_script_capture") {
      const shebang = s.value.lang ? langToShebang(s.value.lang) : undefined;
      emitInlineScriptArtifact(s.value.body, shebang, seen, out);
    } else if (s.type === "run" && s.recover) {
      const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
      collectInlineScripts(recoverSteps, seen, out);
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

/** Resolve the actual body for a ScriptDef. */
function resolveScriptBody(sc: jaiphModule["scripts"][0], _ast: jaiphModule): string {
  return sc.body;
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
  importedWorkflowSymbols: Map<string, string>,
  _workflowSymbol: string,
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
    const rawBody = resolveScriptBody(sc, ast);
    const { shebang, cleanBody } = resolveScriptShebang(rawBody, sc.lang);
    const isBash = scriptShebangIsBash(shebang === "#!/usr/bin/env bash" ? undefined : shebang);
    const processedBody = isBash
      ? cleanBody.split("\n").map((c) => emitScriptBodyLine(c, importedWorkflowSymbols)).join("\n")
      : cleanBody;
    const body = isBash
      ? wrapBashStandaloneScriptBody(processedBody, "")
      : processedBody;
    const content = body.length > 0 ? `${shebang}\n${body}\n` : `${shebang}\n`;
    out.push({ name: sc.name, content });
  }

  // Emit inline script artifacts from workflow steps
  const seen = new Set<string>();
  for (const w of ast.workflows) collectInlineScripts(w.steps, seen, out);

  return out;
}
