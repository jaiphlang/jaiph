import type { jaiphModule } from "../types";
import { scriptShebangIsBash } from "../parse/script-bash";

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

export type ScriptArtifact = { name: string; content: string };

export function buildScriptFiles(
  ast: jaiphModule,
  importedWorkflowSymbols: Map<string, string>,
  _workflowSymbol: string,
): ScriptArtifact[] {
  const out: ScriptArtifact[] = [];
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
