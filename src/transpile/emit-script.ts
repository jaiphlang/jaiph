import type { jaiphModule } from "../types";
import { normalizeShellLocalExport, resolveShellRefs } from "./emit-steps";

/** Emit one Jaiph script body line; Jaiph value-return becomes jaiph::set_return_value. */
function emitScriptBodyLine(cmd: string, importedWorkflowSymbols: Map<string, string>): string {
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
  for (const sc of ast.scripts) {
    const scriptSymbol = `${workflowSymbol}::${sc.name}`;
    for (const comment of sc.comments) {
      out.push(comment);
    }
    out.push(`${scriptSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    emitEnvShims("  ");
    if (sc.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of sc.commands) {
        out.push(`  ${emitScriptBodyLine(cmd, importedWorkflowSymbols)}`);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${scriptSymbol}() {`);
    if (hasModuleMetadataScope) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${scriptSymbol} script ${scriptSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${scriptSymbol} script ${scriptSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
    out.push(`${sc.name}() {`);
    out.push(`  ${scriptSymbol} "$@"`);
    out.push("}");
    out.push("");
  }
}
