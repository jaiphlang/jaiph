import type { jaiphModule } from "../types";
import { type StepEmitCtx, emitStep } from "./emit-steps";

export function emitRuleFunctions(
  out: string[],
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importedModuleHasMetadata: Map<string, boolean>,
  hasModuleMetadataScope: boolean,
  emitEnvShims: (indent: string) => void,
): void {
  for (const rule of ast.rules) {
    const ruleSymbol = `${workflowSymbol}::${rule.name}`;
    for (const comment of rule.comments) {
      out.push(comment);
    }
    out.push(`${ruleSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    emitEnvShims("  ");
    const ruleStepCtx: StepEmitCtx = {
      workflowSymbol,
      importedWorkflowSymbols,
      importedModuleHasMetadata,
      filePath: ast.filePath,
      workflowName: rule.name,
      inRecoverBlock: false,
      failExitsProcess: false,
    };
    if (rule.steps.length === 0) {
      out.push("  :");
    } else {
      for (const st of rule.steps) {
        emitStep(out, "  ", st, ruleStepCtx);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${ruleSymbol}() {`);
    if (hasModuleMetadataScope) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${ruleSymbol} rule jaiph::execute_readonly ${ruleSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${ruleSymbol} rule jaiph::execute_readonly ${ruleSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
  }
}
