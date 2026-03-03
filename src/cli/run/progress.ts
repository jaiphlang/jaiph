import { resolve } from "node:path";
import { jaiphModule } from "../../types";
import { workflowSymbolForFile } from "../../transpiler";

export type TreeRow = {
  rawLabel: string;
  prefix: string;
  branch?: string;
  isRoot: boolean;
  stepFunc?: string;
};

export type RowState = { status: "pending" | "done" | "failed"; elapsedSec?: number };

export function collectWorkflowChildren(
  mod: jaiphModule,
  workflowName: string,
  symbols?: Map<string, string>,
  currentSymbol?: string,
): Array<{ label: string; nested?: string; stepFunc?: string }> {
  const workflow = mod.workflows.find((item) => item.name === workflowName);
  if (!workflow) {
    return [];
  }
  const functionNames = mod.functions.map((item) => item.name);
  const collectFunctionCalls = (command: string): string[] => {
    const hits: string[] = [];
    for (const fnName of functionNames) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])${fnName}(\\s|\\)|$)`);
      if (pattern.test(command)) {
        hits.push(fnName);
      }
    }
    return hits;
  };
  const items: Array<{ label: string; nested?: string; stepFunc?: string }> = [];
  for (const step of workflow.steps) {
    if (step.type === "ensure") {
      const ref = step.ref.value;
      const stepFunc =
        symbols && ref.includes(".")
          ? (() => {
              const dot = ref.indexOf(".");
              const alias = ref.slice(0, dot);
              const name = ref.slice(dot + 1);
              return `${symbols.get(alias) ?? alias}::rule::${name}`;
            })()
          : currentSymbol
            ? `${currentSymbol}::rule::${ref}`
            : undefined;
      items.push({ label: `rule ${ref}`, stepFunc });
      continue;
    }
    if (step.type === "run") {
      const wf = step.workflow.value;
      const stepFunc =
        symbols && wf.includes(".")
          ? (() => {
              const dot = wf.indexOf(".");
              const alias = wf.slice(0, dot);
              const name = wf.slice(dot + 1);
              return `${symbols.get(alias) ?? alias}::workflow::${name}`;
            })()
          : currentSymbol
            ? `${currentSymbol}::workflow::${wf}`
            : undefined;
      items.push({ label: `workflow ${wf}`, nested: wf, stepFunc });
      continue;
    }
    if (step.type === "if_not_ensure_then_run") {
      const ensureRef = step.ensureRef.value;
      const ensureStepFunc =
        symbols && ensureRef.includes(".")
          ? (() => {
              const dot = ensureRef.indexOf(".");
              const alias = ensureRef.slice(0, dot);
              const name = ensureRef.slice(dot + 1);
              return `${symbols.get(alias) ?? alias}::rule::${name}`;
            })()
          : currentSymbol
            ? `${currentSymbol}::rule::${ensureRef}`
            : undefined;
      items.push({ label: `rule ${ensureRef}`, stepFunc: ensureStepFunc });
      const wf = step.runWorkflow.value;
      const runStepFunc =
        symbols && wf.includes(".")
          ? (() => {
              const dot = wf.indexOf(".");
              const alias = wf.slice(0, dot);
              const name = wf.slice(dot + 1);
              return `${symbols.get(alias) ?? alias}::workflow::${name}`;
            })()
          : currentSymbol
            ? `${currentSymbol}::workflow::${wf}`
            : undefined;
      items.push({ label: `workflow ${wf}`, nested: wf, stepFunc: runStepFunc });
      continue;
    }
    if (step.type === "if_not_ensure_then_shell") {
      const ref = step.ensureRef.value;
      const stepFunc =
        symbols && ref.includes(".")
          ? (() => {
              const dot = ref.indexOf(".");
              const alias = ref.slice(0, dot);
              const name = ref.slice(dot + 1).replace(/\./g, "_");
              return `${symbols.get(alias) ?? alias}::rule::${name}`;
            })()
          : currentSymbol
            ? `${currentSymbol}::rule::${ref}`
            : undefined;
      items.push({ label: `rule ${ref}`, stepFunc });
      continue;
    }
    if (step.type === "prompt") {
      items.push({ label: "prompt prompt", stepFunc: "jaiph__prompt" });
      continue;
    }
    if (step.type === "shell") {
      for (const fnName of collectFunctionCalls(step.command)) {
        const stepFunc = currentSymbol ? `${currentSymbol}::function::${fnName}` : undefined;
        items.push({ label: `function ${fnName}`, stepFunc });
      }
    }
  }
  return items;
}

export function buildRunTreeRows(
  mod: jaiphModule,
  rootLabel = "workflow default",
  importedModules?: Map<string, jaiphModule>,
  rootDir?: string,
): TreeRow[] {
  const rows: TreeRow[] = [{ rawLabel: rootLabel, prefix: "", isRoot: true }];
  const symbols = new Map<string, string>();
  if (importedModules && rootDir) {
    const root = resolve(rootDir);
    for (const [alias, subMod] of importedModules) {
      symbols.set(alias, workflowSymbolForFile(subMod.filePath, root));
    }
  }
  const mainSymbol = rootDir ? workflowSymbolForFile(mod.filePath, resolve(rootDir)) : undefined;
  const visited = new Set<string>(["default"]);
  const renderChildren = (currentMod: jaiphModule, workflowName: string, prefix: string, currentSymbol?: string): void => {
    const children = collectWorkflowChildren(currentMod, workflowName, symbols.size > 0 ? symbols : undefined, currentSymbol);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      rows.push({ rawLabel: child.label, prefix, branch, isRoot: false, stepFunc: child.stepFunc });
      if (!child.nested) {
        continue;
      }
      const nested = child.nested;
      if (nested.includes(".")) {
        const dot = nested.indexOf(".");
        const alias = nested.slice(0, dot);
        const wfName = nested.slice(dot + 1);
        const subMod = importedModules?.get(alias);
        if (subMod) {
          const subSymbol = symbols.get(alias);
          renderChildren(subMod, wfName, `${prefix}${isLast ? "    " : "│   "}`, subSymbol);
        }
        continue;
      }
      if (visited.has(nested)) {
        continue;
      }
      visited.add(nested);
      renderChildren(currentMod, nested, `${prefix}${isLast ? "    " : "│   "}`, currentSymbol);
    }
  };
  renderChildren(mod, "default", "", mainSymbol);
  return rows;
}

export function parseLabel(rawLabel: string): { kind: string; name: string } {
  const firstSpace = rawLabel.indexOf(" ");
  if (firstSpace === -1) {
    return { kind: "step", name: rawLabel };
  }
  return {
    kind: rawLabel.slice(0, firstSpace),
    name: rawLabel.slice(firstSpace + 1),
  };
}

export function styleKeywordLabel(rawLabel: string): string {
  const { kind, name } = parseLabel(rawLabel);
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return `${kind} ${name}`;
  }
  return `\u001b[1m${kind}\u001b[0m ${name}`;
}

export function styleDim(text: string): string {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return text;
  }
  return `\u001b[2m${text}\u001b[0m`;
}

export function formatElapsedDuration(elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    const seconds = elapsedMs / 1000;
    return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function renderProgressTree(
  rows: TreeRow[],
  states: RowState[],
  rootElapsedSec?: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.isRoot) {
      const rootStatus = typeof rootElapsedSec === "number" ? ` ${styleDim(`(${rootElapsedSec}s)`)}` : "";
      lines.push(`${styleKeywordLabel(row.rawLabel)}${rootStatus}`);
      continue;
    }
    const state = states[i];
    const suffix =
      state.status === "pending"
        ? styleDim("(pending)")
        : state.status === "failed"
          ? styleDim(`(${state.elapsedSec ?? 0}s failed)`)
          : styleDim(`(${state.elapsedSec ?? 0}s)`);
    lines.push(`${row.prefix}${row.branch ?? ""}${styleKeywordLabel(row.rawLabel)} ${suffix}`);
  }
  return lines.join("\n");
}

function styleTreeLabel(label: string): string {
  return styleKeywordLabel(label);
}

export function renderRunTree(mod: jaiphModule, rootLabel = "workflow default"): string {
  const lines = [styleTreeLabel(rootLabel)];
  const visited = new Set<string>(["default"]);

  const renderChildren = (workflowName: string, prefix: string): void => {
    const children = collectWorkflowChildren(mod, workflowName);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${branch}${styleTreeLabel(child.label)}`);
      if (!child.nested) {
        continue;
      }
      if (child.nested.includes(".") || visited.has(child.nested)) {
        continue;
      }
      visited.add(child.nested);
      renderChildren(child.nested, `${prefix}${isLast ? "    " : "│   "}`);
    }
  };

  renderChildren("default", "");
  return lines.join("\n");
}
