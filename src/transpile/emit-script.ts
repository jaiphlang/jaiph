import type { jaiphModule } from "../types";
import { normalizeShellLocalExport, resolveShellRefs } from "./emit-steps";

/** Emit one Jaiph function body line; Jaiph value-return becomes jaiph::set_return_value. */
function emitFunctionBodyLine(cmd: string, importedWorkflowSymbols: Map<string, string>): string {
  const t = cmd.trim();
  const ret = t.match(/^return\s+(.+)$/s);
  if (ret) {
    const arg = ret[1].trim();
    const isBashExitCode = /^[0-9]+$/.test(arg) || arg === "$?";
    if (!isBashExitCode && (arg.startsWith('"') || arg.startsWith("'") || arg.startsWith("$"))) {
      return `jaiph::set_return_value ${arg}; return 0`;
    }
  }
  return normalizeShellLocalExport(resolveShellRefs(cmd, importedWorkflowSymbols));
}

export function emitScriptFunctions(
  out: string[],
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  hasModuleMetadataScope: boolean,
  emitEnvShims: (indent: string) => void,
): void {
  for (const fn of ast.functions) {
    const functionSymbol = `${workflowSymbol}::${fn.name}`;
    for (const comment of fn.comments) {
      out.push(comment);
    }
    out.push(`${functionSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    emitEnvShims("  ");
    if (fn.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of fn.commands) {
        out.push(`  ${emitFunctionBodyLine(cmd, importedWorkflowSymbols)}`);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${functionSymbol}() {`);
    if (hasModuleMetadataScope) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${functionSymbol} function ${functionSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${functionSymbol} function ${functionSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
    out.push(`${fn.name}() {`);
    out.push(`  ${functionSymbol} "$@"`);
    out.push("}");
    out.push("");
  }
}
