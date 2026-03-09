import { resolve } from "node:path";
import { jaiphModule, type WorkflowStepDef } from "../../types";
import { workflowSymbolForFile } from "../../transpiler";

export type TreeRow = {
  rawLabel: string;
  prefix: string;
  branch?: string;
  isRoot: boolean;
  stepFunc?: string;
};

export type RowState = { status: "pending" | "done" | "failed"; elapsedSec?: number };

function selfRecursiveRunSiteCount(mod: jaiphModule, workflowName: string): number {
  const workflow = mod.workflows.find((item) => item.name === workflowName);
  if (!workflow) {
    return 0;
  }
  let count = 0;
  for (const step of workflow.steps) {
    if (step.type === "run" && step.workflow.value === workflowName) {
      count += 1;
      continue;
    }
    if (step.type === "if_not_ensure_then_run") {
      for (const wfRef of step.runWorkflows) {
        if (wfRef.workflow.value === workflowName) {
          count += 1;
        }
      }
      continue;
    }
    if (step.type === "if_not_shell_then") {
      for (const thenStep of step.thenSteps) {
        if (thenStep.type === "run" && thenStep.workflow.value === workflowName) {
          count += 1;
        }
      }
      continue;
    }
    if (step.type === "if_not_ensure_then") {
      for (const thenStep of step.thenSteps) {
        if (thenStep.type === "run" && thenStep.workflow.value === workflowName) {
          count += 1;
        }
      }
    }
  }
  return count;
}

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
  const stepToItems = (s: WorkflowStepDef): Array<{ label: string; nested?: string; stepFunc?: string }> => {
    if (s.type === "run") {
      const wf = s.workflow.value;
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
      return [{ label: `workflow ${wf}`, nested: wf, stepFunc }];
    }
    if (s.type === "ensure") {
      const ref = s.ref.value;
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
      const arr: Array<{ label: string; nested?: string; stepFunc?: string }> = [
        { label: `rule ${ref}`, stepFunc },
      ];
      if (s.recover) {
        const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
        for (const r of steps) {
          arr.push(...stepToItems(r));
        }
      }
      return arr;
    }
    if (s.type === "prompt") {
      return [{ label: "prompt prompt", stepFunc: "jaiph::prompt" }];
    }
    if (s.type === "shell") {
      return collectFunctionCalls(s.command).map((fnName) => ({
        label: `function ${fnName}`,
        stepFunc: currentSymbol ? `${currentSymbol}::function::${fnName}` : undefined,
      }));
    }
    return [];
  };
  for (const step of workflow.steps) {
    if (step.type === "ensure") {
      items.push(...stepToItems(step));
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
      for (const runStep of step.runWorkflows) {
        const wf = runStep.workflow.value;
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
      }
      continue;
    }
    if (step.type === "if_not_ensure_then") {
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
      for (const thenStep of step.thenSteps) {
        if (thenStep.type === "run") {
          const wf = thenStep.workflow.value;
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
        if (thenStep.type === "prompt") {
          items.push({ label: "prompt prompt", stepFunc: "jaiph::prompt" });
          continue;
        }
        for (const fnName of collectFunctionCalls(thenStep.command)) {
          const stepFunc = currentSymbol ? `${currentSymbol}::function::${fnName}` : undefined;
          items.push({ label: `function ${fnName}`, stepFunc });
        }
      }
      continue;
    }
    if (step.type === "if_not_shell_then") {
      for (const thenStep of step.thenSteps) {
        if (thenStep.type === "run") {
          const wf = thenStep.workflow.value;
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
        }
      }
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
      items.push({ label: "prompt prompt", stepFunc: "jaiph::prompt" });
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
  const renderChildren = (
    currentMod: jaiphModule,
    workflowName: string,
    prefix: string,
    currentSymbol?: string,
    recursionDepth = 0,
  ): void => {
    const children = collectWorkflowChildren(currentMod, workflowName, symbols.size > 0 ? symbols : undefined, currentSymbol);
    const selfRecursiveSites = selfRecursiveRunSiteCount(currentMod, workflowName);
    const recursionSiteIndexForDepth = selfRecursiveSites > 0 ? Math.min(recursionDepth, selfRecursiveSites - 1) : -1;
    let currentSelfRecursiveSiteIndex = 0;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const childIsLocalSelfRecursion =
        child.nested !== undefined &&
        !child.nested.includes(".") &&
        child.nested === workflowName;
      if (childIsLocalSelfRecursion) {
        const shouldExpand = selfRecursiveSites > 0
          && recursionDepth < selfRecursiveSites
          && currentSelfRecursiveSiteIndex === recursionSiteIndexForDepth;
        const shouldRender = recursionDepth === 0 || shouldExpand;
        currentSelfRecursiveSiteIndex += 1;
        if (!shouldRender) {
          continue;
        }
      }
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      rows.push({ rawLabel: child.label, prefix, branch, isRoot: false, stepFunc: child.stepFunc });
      if (!child.nested) {
        continue;
      }
      const nested = child.nested;
      if (childIsLocalSelfRecursion) {
        const shouldExpand = selfRecursiveSites > 0
          && recursionDepth < selfRecursiveSites
          && (currentSelfRecursiveSiteIndex - 1) === recursionSiteIndexForDepth;
        if (shouldExpand) {
          renderChildren(
            currentMod,
            nested,
            `${prefix}${isLast ? "    " : "│   "}`,
            currentSymbol,
            recursionDepth + 1,
          );
        }
        continue;
      }
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

  const renderChildren = (workflowName: string, prefix: string, recursionDepth = 0): void => {
    const children = collectWorkflowChildren(mod, workflowName);
    const selfRecursiveSites = selfRecursiveRunSiteCount(mod, workflowName);
    const recursionSiteIndexForDepth = selfRecursiveSites > 0 ? Math.min(recursionDepth, selfRecursiveSites - 1) : -1;
    let currentSelfRecursiveSiteIndex = 0;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const childIsLocalSelfRecursion =
        child.nested !== undefined &&
        !child.nested.includes(".") &&
        child.nested === workflowName;
      if (childIsLocalSelfRecursion) {
        const shouldExpand = selfRecursiveSites > 0
          && recursionDepth < selfRecursiveSites
          && currentSelfRecursiveSiteIndex === recursionSiteIndexForDepth;
        const shouldRender = recursionDepth === 0 || shouldExpand;
        currentSelfRecursiveSiteIndex += 1;
        if (!shouldRender) {
          continue;
        }
      }
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${branch}${styleTreeLabel(child.label)}`);
      if (!child.nested) {
        continue;
      }
      if (childIsLocalSelfRecursion) {
        const shouldExpand = selfRecursiveSites > 0
          && recursionDepth < selfRecursiveSites
          && (currentSelfRecursiveSiteIndex - 1) === recursionSiteIndexForDepth;
        if (shouldExpand) {
          renderChildren(child.nested, `${prefix}${isLast ? "    " : "│   "}`, recursionDepth + 1);
        }
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

export type RuntimeNodeStatus = "running" | "done" | "failed";

export type RuntimeNode = {
  id: string;
  parentId: string | null;
  rawLabel: string;
  state: RuntimeNodeStatus;
  startedAtMs: number;
  elapsedSec?: number;
  children: string[];
};

export type RuntimeGraphStore = {
  rootLabel: string;
  rootStepId: string | null;
  nodesById: Map<string, RuntimeNode>;
  rootNodeIds: string[];
};

export function createRuntimeGraphStore(rootLabel = "workflow default"): RuntimeGraphStore {
  return {
    rootLabel,
    rootStepId: null,
    nodesById: new Map<string, RuntimeNode>(),
    rootNodeIds: [],
  };
}

function computeRuntimeNodePrefix(store: RuntimeGraphStore, nodeId: string): { prefix: string; branch: string } {
  const segments: string[] = [];
  let currentId: string | null = nodeId;
  while (currentId) {
    const node = store.nodesById.get(currentId);
    if (!node) break;
    const siblingIds = node.parentId === null
      ? store.rootNodeIds
      : (store.nodesById.get(node.parentId)?.children ?? []);
    const isLast = siblingIds[siblingIds.length - 1] === currentId;
    segments.push(isLast ? "    " : "│   ");
    currentId = node.parentId;
  }
  const node = store.nodesById.get(nodeId);
  if (!node) return { prefix: "", branch: "└── " };
  const siblingIds = node.parentId === null
    ? store.rootNodeIds
    : (store.nodesById.get(node.parentId)?.children ?? []);
  const isLast = siblingIds[siblingIds.length - 1] === nodeId;
  segments.pop();
  return {
    prefix: segments.reverse().join(""),
    branch: isLast ? "└── " : "├── ",
  };
}

function computeRuntimeIndent(store: RuntimeGraphStore, nodeId: string): string {
  let depth = 0;
  let currentId: string | null = nodeId;
  while (currentId) {
    const node = store.nodesById.get(currentId);
    if (!node || node.parentId === null) break;
    depth += 1;
    currentId = node.parentId;
  }
  return "    ".repeat(depth);
}

export function beginRuntimeNode(
  store: RuntimeGraphStore,
  nodeId: string,
  parentId: string | null,
  rawLabel: string,
  startedAtMs: number,
): RuntimeNode {
  const node: RuntimeNode = {
    id: nodeId,
    parentId,
    rawLabel,
    state: "running",
    startedAtMs,
    children: [],
  };
  store.nodesById.set(nodeId, node);
  if (parentId) {
    const parent = store.nodesById.get(parentId);
    if (parent) {
      parent.children.push(nodeId);
    } else {
      store.rootNodeIds.push(nodeId);
    }
  } else {
    store.rootNodeIds.push(nodeId);
  }
  return node;
}

export function completeRuntimeNode(
  store: RuntimeGraphStore,
  nodeId: string,
  status: number,
  elapsedSec: number,
): RuntimeNode | undefined {
  const node = store.nodesById.get(nodeId);
  if (!node) return undefined;
  node.state = status === 0 ? "done" : "failed";
  node.elapsedSec = elapsedSec;
  return node;
}

export function runtimeRunningLine(
  store: RuntimeGraphStore,
  nodeId: string,
  runningSeconds: number,
): string {
  const node = store.nodesById.get(nodeId);
  if (!node) return "";
  const tree = computeRuntimeNodePrefix(store, nodeId);
  return `${tree.prefix}${tree.branch}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(running ${runningSeconds}s)`)}`;
}

export function runtimeCompletedLine(store: RuntimeGraphStore, nodeId: string): string {
  const node = store.nodesById.get(nodeId);
  if (!node) return "";
  const tree = computeRuntimeNodePrefix(store, nodeId);
  if (node.state === "failed") {
    return `${tree.prefix}${tree.branch}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(${node.elapsedSec ?? 0}s failed)`)}`;
  }
  return `${tree.prefix}${tree.branch}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(${node.elapsedSec ?? 0}s)`)}`;
}

export function runtimeRunningIndentLine(
  store: RuntimeGraphStore,
  nodeId: string,
  runningSeconds: number,
): string {
  const node = store.nodesById.get(nodeId);
  if (!node) return "";
  const indent = computeRuntimeIndent(store, nodeId);
  return `${indent}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(running ${runningSeconds}s)`)}`;
}

export function runtimeCompletedIndentLine(store: RuntimeGraphStore, nodeId: string): string {
  const node = store.nodesById.get(nodeId);
  if (!node) return "";
  const indent = computeRuntimeIndent(store, nodeId);
  if (node.state === "failed") {
    return `${indent}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(${node.elapsedSec ?? 0}s failed)`)}`;
  }
  return `${indent}${styleKeywordLabel(node.rawLabel)} ${styleDim(`(${node.elapsedSec ?? 0}s)`)}`;
}

export function renderRuntimeIndentRows(store: RuntimeGraphStore): string[] {
  const lines: string[] = [];
  const walk = (nodeIds: string[]): void => {
    for (const nodeId of nodeIds) {
      const node = store.nodesById.get(nodeId);
      if (!node) continue;
      const indent = computeRuntimeIndent(store, nodeId);
      const suffix = node.state === "failed"
        ? styleDim(`(${node.elapsedSec ?? 0}s failed)`)
        : styleDim(`(${node.elapsedSec ?? 0}s)`);
      lines.push(`${indent}${styleKeywordLabel(node.rawLabel)} ${suffix}`);
      walk(node.children);
    }
  };
  walk(store.rootNodeIds);
  return lines;
}

export function renderRuntimeTreeRows(store: RuntimeGraphStore): string[] {
  const lines: string[] = [];
  const walk = (nodeIds: string[], prefix: string): void => {
    for (let i = 0; i < nodeIds.length; i += 1) {
      const nodeId = nodeIds[i];
      const node = store.nodesById.get(nodeId);
      if (!node) continue;
      const isLast = i === nodeIds.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const suffix = node.state === "failed"
        ? styleDim(`(${node.elapsedSec ?? 0}s failed)`)
        : styleDim(`(${node.elapsedSec ?? 0}s)`);
      lines.push(`${prefix}${branch}${styleKeywordLabel(node.rawLabel)} ${suffix}`);
      walk(node.children, `${prefix}${isLast ? "    " : "│   "}`);
    }
  };
  walk(store.rootNodeIds, "");
  return lines;
}
