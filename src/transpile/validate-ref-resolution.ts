import { jaiphError } from "../errors";
import type { jaiphModule } from "../types";

export type RefTargetKind = "rule" | "workflow" | "function";

/** Look up which kind a name belongs to in a module: "rule", "workflow", "function", or undefined. */
export function lookupKind(mod: jaiphModule, name: string): RefTargetKind | undefined {
  if (mod.rules.some((r) => r.name === name)) return "rule";
  if (mod.workflows.some((w) => w.name === name)) return "workflow";
  if (mod.functions.some((f) => f.name === name)) return "function";
  return undefined;
}

export interface RefResolutionContext {
  importsByAlias: Map<string, string>;
  importedAstCache: Map<string, jaiphModule>;
  localRules: Set<string>;
  localWorkflows: Set<string>;
  localFunctions: Set<string>;
}

function localSymbolKind(
  name: string,
  ctx: RefResolutionContext,
): RefTargetKind | undefined {
  if (ctx.localRules.has(name)) return "rule";
  if (ctx.localWorkflows.has(name)) return "workflow";
  if (ctx.localFunctions.has(name)) return "function";
  return undefined;
}

function importedHasAllowedKind(
  mod: jaiphModule,
  name: string,
  allowed: Set<RefTargetKind>,
): boolean {
  if (allowed.has("rule") && mod.rules.some((r) => r.name === name)) return true;
  if (allowed.has("workflow") && mod.workflows.some((w) => w.name === name)) return true;
  if (allowed.has("function") && mod.functions.some((f) => f.name === name)) return true;
  return false;
}

export interface RefExpectMessages {
  allowedKinds: Set<RefTargetKind>;
  invalidSplitRef: (refValue: string) => string;
  unknownImportAlias: (alias: string, refValue: string) => string;
  unknownLocal: (refValue: string) => string;
  missingImported: (refValue: string) => string;
  wrongLocal: Partial<Record<RefTargetKind, (shortName: string, refValue: string) => string>>;
  wrongImported: Partial<Record<RefTargetKind, (refValue: string) => string>>;
}

export interface BareSendRefMessages {
  unknownImportAlias: (alias: string, refValue: string) => string;
  unknownLocal: (refValue: string) => string;
  wrongWorkflowLocal: (refValue: string) => string;
  wrongFunctionLocal: (refValue: string) => string;
  wrongRuleLocal: (refValue: string) => string;
  wrongWorkflowImported: (refValue: string) => string;
  wrongFunctionImported: (refValue: string) => string;
  wrongRuleImported: (refValue: string) => string;
  unknownSymbolImported: (refValue: string) => string;
}

export type RefValidationSpec =
  | { mode: "expect"; expect: RefExpectMessages }
  | {
      mode: "bare_send_rhs";
      bareSend: BareSendRefMessages;
      lookupImportedKind: (alias: string, name: string) => RefTargetKind | undefined;
    };

function throwWrongLocal(
  filePath: string,
  line: number,
  col: number,
  wrongLocal: RefExpectMessages["wrongLocal"],
  k: RefTargetKind,
  shortName: string,
  refValue: string,
): never {
  const fn = wrongLocal[k];
  if (!fn) {
    throw new Error(`validateRef: missing wrongLocal message for kind "${k}"`);
  }
  throw jaiphError(filePath, line, col, "E_VALIDATE", fn(shortName, refValue));
}

function throwWrongImported(
  filePath: string,
  line: number,
  col: number,
  wrongImported: RefExpectMessages["wrongImported"],
  k: RefTargetKind,
  refValue: string,
): never {
  const fn = wrongImported[k];
  if (!fn) {
    throw new Error(`validateRef: missing wrongImported message for kind "${k}"`);
  }
  throw jaiphError(filePath, line, col, "E_VALIDATE", fn(refValue));
}

/**
 * Validates a reference: either it must resolve to one of the allowed kinds (expect mode),
 * or it must not resolve to rule/workflow/function (bare send RHS mode).
 */
export function validateRef(
  ref: { value: string; loc: { line: number; col: number } },
  mod: jaiphModule,
  ctx: RefResolutionContext,
  spec: RefValidationSpec,
): void {
  const parts = ref.value.split(".");
  const { line, col } = ref.loc;
  const fp = mod.filePath;

  if (spec.mode === "bare_send_rhs") {
    const msg = spec.bareSend;
    if (parts.length === 1) {
      const name = parts[0];
      const kind = lookupKind(mod, name);
      if (kind === "workflow") {
        throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongWorkflowLocal(ref.value));
      }
      if (kind === "function") {
        throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongFunctionLocal(ref.value));
      }
      if (kind === "rule") {
        throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongRuleLocal(ref.value));
      }
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownLocal(ref.value));
    }
    const [alias, importedName] = parts;
    if (!ctx.importsByAlias.has(alias)) {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownImportAlias(alias, ref.value));
    }
    const ik = spec.lookupImportedKind(alias, importedName);
    if (ik === "workflow") {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongWorkflowImported(ref.value));
    }
    if (ik === "function") {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongFunctionImported(ref.value));
    }
    if (ik === "rule") {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongRuleImported(ref.value));
    }
    throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownSymbolImported(ref.value));
  }

  const expectSpec = spec.expect;
  if (parts.length === 1) {
    const name = parts[0];
    const k = localSymbolKind(name, ctx);
    if (k && expectSpec.allowedKinds.has(k)) return;
    if (k) throwWrongLocal(fp, line, col, expectSpec.wrongLocal, k, name, ref.value);
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.unknownLocal(ref.value));
  }

  if (parts.length !== 2) {
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.invalidSplitRef(ref.value));
  }

  const [alias, importedName] = parts;
  const importedFile = ctx.importsByAlias.get(alias);
  if (!importedFile) {
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.unknownImportAlias(alias, ref.value));
  }
  const importedAst = ctx.importedAstCache.get(importedFile)!;
  if (importedHasAllowedKind(importedAst, importedName, expectSpec.allowedKinds)) return;

  const ik = lookupKind(importedAst, importedName);
  if (ik) throwWrongImported(fp, line, col, expectSpec.wrongImported, ik, ref.value);
  throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.missingImported(ref.value));
}

export const RULE_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["rule"]),
  invalidSplitRef: (rv) => `invalid rule reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for rule reference "${rv}"`,
  unknownLocal: (rv) => `unknown local rule reference "${rv}"`,
  missingImported: (rv) => `imported rule "${rv}" does not exist`,
  wrongLocal: {
    workflow: (name) => `workflow "${name}" must be called with run`,
    function: (name) => `function "${name}" cannot be called with ensure`,
  },
  wrongImported: {
    workflow: (rv) => `workflow "${rv}" must be called with run`,
    function: (rv) => `function "${rv}" cannot be called with ensure`,
  },
};

export const WORKFLOW_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["workflow"]),
  invalidSplitRef: (rv) => `invalid workflow reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for workflow reference "${rv}"`,
  unknownLocal: (rv) => `unknown local workflow reference "${rv}"`,
  missingImported: (rv) => `imported workflow "${rv}" does not exist`,
  wrongLocal: {
    rule: (name) => `rule "${name}" must be called with ensure`,
    function: (name) => `function "${name}" cannot be called with run`,
  },
  wrongImported: {
    rule: (rv) => `rule "${rv}" must be called with ensure`,
    function: (rv) => `function "${rv}" cannot be called with run`,
  },
};

export const RUN_IN_RULE_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["function"]),
  invalidSplitRef: (rv) => `invalid run target reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for run target "${rv}"`,
  unknownLocal: (rv) =>
    `unknown local function reference "${rv}" (run in rules must target a function)`,
  missingImported: (rv) =>
    `imported function "${rv}" does not exist (run in rules must target a function)`,
  wrongLocal: {
    workflow: (name) => `run inside a rule must target a function, not workflow "${name}"`,
    rule: (name) => `rule "${name}" must be called with ensure, not run`,
  },
  wrongImported: {
    workflow: (rv) => `run inside a rule must target a function, not workflow "${rv}"`,
    rule: (rv) => `rule "${rv}" must be called with ensure, not run`,
  },
};

export const RUN_TARGET_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["workflow", "function"]),
  invalidSplitRef: (rv) => `invalid run target reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for run target "${rv}"`,
  unknownLocal: (rv) => `unknown local workflow or function reference "${rv}"`,
  missingImported: (rv) => `imported workflow or function "${rv}" does not exist`,
  wrongLocal: {
    rule: (name) => `rule "${name}" must be called with ensure, not run`,
  },
  wrongImported: {
    rule: (rv) => `rule "${rv}" must be called with ensure, not run`,
  },
};

export const BARE_SEND_REF_MSG: BareSendRefMessages = {
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for send reference "${rv}"`,
  unknownLocal: (rv) => `unknown symbol "${rv}" in send right-hand side`,
  wrongWorkflowLocal: (rv) => `workflow "${rv}" must be called with run`,
  wrongFunctionLocal: (rv) => `function "${rv}" must be called with run`,
  wrongRuleLocal: (rv) => `rule "${rv}" must be called with ensure`,
  wrongWorkflowImported: (rv) => `workflow "${rv}" must be called with run`,
  wrongFunctionImported: (rv) => `function "${rv}" must be called with run`,
  wrongRuleImported: (rv) => `rule "${rv}" must be called with ensure`,
  unknownSymbolImported: (rv) => `unknown symbol "${rv}" in send right-hand side`,
};
