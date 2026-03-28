import type { jaiphModule } from "../types";
import { scriptShebangIsBash } from "../parse/script-bash";
import { normalizeShellLocalExport, resolveShellRefs } from "./emit-steps";


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
  const indented = body
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : ""))
    .join("\n");
  return [
    "set -euo pipefail",
    "__jaiph_script_entry() {",
    preamble,
    indented,
    "}",
    '__jaiph_script_entry "$@"',
  ].join("\n");
}

export function buildScriptFiles(
  ast: jaiphModule,
  importedWorkflowSymbols: Map<string, string>,
  _workflowSymbol: string,
): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  for (const sc of ast.scripts) {
    const shebang = sc.shebang ?? "#!/usr/bin/env bash";
    const rawBody = scriptShebangIsBash(sc.shebang)
      ? sc.commands.map((c) => emitScriptBodyLine(c, importedWorkflowSymbols)).join("\n")
      : sc.commands.join("\n");
    const body = scriptShebangIsBash(sc.shebang)
      ? wrapBashStandaloneScriptBody(rawBody, "")
      : rawBody;
    const content = body.length > 0 ? `${shebang}\n${body}\n` : `${shebang}\n`;
    out.push({ name: sc.name, content });
  }
  return out;
}

export function emitScriptFunctions(
  out: string[],
  ast: jaiphModule,
  workflowSymbol: string,
  hasModuleMetadataScope: boolean,
): void {
  for (const sc of ast.scripts) {
    const scriptSymbol = `${workflowSymbol}::${sc.name}`;
    for (const comment of sc.comments) {
      out.push(comment);
    }
    out.push(`${scriptSymbol}() {`);
    if (hasModuleMetadataScope) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${scriptSymbol} script "$JAIPH_SCRIPTS/${sc.name}" "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${scriptSymbol} script "$JAIPH_SCRIPTS/${sc.name}" "$@"`);
    }
    out.push("}");
    out.push("");
    out.push(`${sc.name}() {`);
    out.push(`  ${scriptSymbol} "$@"`);
    out.push("}");
    out.push("");
  }
}
