import { resolve } from "node:path";
import { jaiphModule, type WorkflowStepDef } from "../../types";
import { workflowSymbolForFile } from "../../transpiler";

export type TreeRow = {
  rawLabel: string;
  prefix: string;
  isRoot: boolean;
  stepFunc?: string;
};

const PROMPT_PREVIEW_MAX = 24;

/** Extract prompt text from step.raw (between first and matching double-quote) for preview. */
function promptPreviewFromRaw(raw: string): string {
  const start = raw.indexOf('"');
  if (start === -1) return "";
  let content = "";
  for (let i = start + 1; i < raw.length; i += 1) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      content += raw[i + 1];
      i += 1;
      continue;
    }
    if (raw[i] === '"') break;
    content += raw[i];
  }
  return content;
}

function formatPromptLabel(promptRaw: string): string {
  const content = promptPreviewFromRaw(promptRaw);
  const oneLine = content.replace(/\s+/g, " ").trim();
  const preview =
    oneLine.length > PROMPT_PREVIEW_MAX ? oneLine.slice(0, PROMPT_PREVIEW_MAX) + "..." : oneLine;
  const escaped = preview.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `prompt "${escaped}"`;
}

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
      return [{ label: formatPromptLabel(s.raw), stepFunc: "jaiph::prompt" }];
    }
    if (s.type === "log") {
      return [{ label: `log ${s.message}` }];
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
          items.push({ label: formatPromptLabel(thenStep.raw), stepFunc: "jaiph::prompt" });
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
      items.push({ label: formatPromptLabel(step.raw), stepFunc: "jaiph::prompt" });
      continue;
    }
    if (step.type === "log") {
      items.push({ label: `log ${step.message}` });
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
      rows.push({ rawLabel: child.label, prefix, isRoot: false, stepFunc: child.stepFunc });
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
            `${prefix}    `,
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
          renderChildren(subMod, wfName, `${prefix}    `, subSymbol);
        }
        continue;
      }
      if (visited.has(nested)) {
        continue;
      }
      visited.add(nested);
      renderChildren(currentMod, nested, `${prefix}    `, currentSymbol);
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

export function styleYellow(text: string): string {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return text;
  }
  return `\u001b[33m${text}\u001b[0m`;
}

export function styleBold(text: string): string {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (!enabled) {
    return text;
  }
  return `\u001b[1m${text}\u001b[0m`;
}

/** Format the single TTY bottom status line: "  RUNNING workflow <name> (X.Xs)". Only this line is updated in place. */
export function formatRunningBottomLine(workflowName: string, elapsedSec: number): string {
  const timeStr = `${elapsedSec.toFixed(1)}s`;
  return `${styleYellow("▸ RUNNING")}${styleBold(" workflow")} ${workflowName} ${styleDim(`(${timeStr})`)}`;
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



