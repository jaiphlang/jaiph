import { resolve } from "node:path";
import { jaiphModule, type Expr, type WorkflowStepDef } from "../../types";
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
    if (step.type === "exec" && step.body.kind === "call" && step.body.callee.value === workflowName) {
      count += 1;
      continue;
    }
  }
  return count;
}

/** Short surface label for an Expr value (used in `return` / `const` rows). */
function exprLabel(expr: Expr): string {
  if (expr.kind === "literal") return expr.raw;
  if (expr.kind === "call") return `run ${expr.callee.value}(...)`;
  if (expr.kind === "ensure_call") return `ensure ${expr.callee.value}(...)`;
  if (expr.kind === "inline_script") return "run `...`(...)";
  if (expr.kind === "prompt") return `prompt ${expr.raw}`;
  if (expr.kind === "match") return `match ${expr.match.subject}`;
  if (expr.kind === "shell") return expr.command;
  return expr.ref.value;
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
  const items: Array<{ label: string; nested?: string; stepFunc?: string }> = [];
  const refStepFunc = (ref: string): string | undefined =>
    symbols && ref.includes(".")
      ? (() => {
          const dot = ref.indexOf(".");
          const alias = ref.slice(0, dot);
          const name = ref.slice(dot + 1);
          return `${symbols.get(alias) ?? alias}::${name}`;
        })()
      : currentSymbol
        ? `${currentSymbol}::${ref}`
        : undefined;
  const stepToItems = (s: WorkflowStepDef): Array<{ label: string; nested?: string; stepFunc?: string }> => {
    if (s.type === "exec") {
      const body = s.body;
      if (body.kind === "call") {
        const wf = body.callee.value;
        const asyncPrefix = body.async ? "async " : "";
        const arr: Array<{ label: string; nested?: string; stepFunc?: string }> = [
          { label: `${asyncPrefix}workflow ${wf}`, nested: wf, stepFunc: refStepFunc(wf) },
        ];
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) arr.push(...stepToItems(r));
        } else if (s.catch) {
          const steps = "single" in s.catch ? [s.catch.single] : s.catch.block;
          for (const r of steps) arr.push(...stepToItems(r));
        }
        return arr;
      }
      if (body.kind === "ensure_call") {
        const ref = body.callee.value;
        const arr: Array<{ label: string; nested?: string; stepFunc?: string }> = [
          { label: `rule ${ref}`, stepFunc: refStepFunc(ref) },
        ];
        if (s.catch) {
          const steps = "single" in s.catch ? [s.catch.single] : s.catch.block;
          for (const r of steps) arr.push(...stepToItems(r));
        }
        return arr;
      }
      if (body.kind === "prompt") {
        return [{ label: formatPromptLabel(body.raw), stepFunc: "jaiph::prompt" }];
      }
      if (body.kind === "inline_script") {
        return [{ label: "script (inline)" }];
      }
      if (body.kind === "shell") {
        const t = body.command.trim();
        const label = t.length > 56 ? `${t.slice(0, 53)}...` : t;
        return [{ label: `$ ${label}` }];
      }
      if (body.kind === "match") {
        // standalone match — no nested rendering
        return [];
      }
      return [];
    }
    if (s.type === "say") {
      const msg = exprLabel(s.message);
      if (s.level === "log") return [{ label: `ℹ ${msg}` }];
      if (s.level === "logerr") return [{ label: `! ${msg}` }];
      return [{ label: `fail ${msg}` }];
    }
    if (s.type === "send") {
      return [{ label: `${s.channel} <- send` }];
    }
    if (s.type === "const") {
      const constItems: Array<{ label: string; nested?: string; stepFunc?: string }> = [
        { label: `const ${s.name}` },
      ];
      if (s.value.kind === "match") {
        for (const arm of s.value.match.arms) {
          const body = arm.body.trimStart();
          const runM = body.match(/^run\s+([A-Za-z_][A-Za-z0-9_.]*)\(/);
          if (runM) {
            constItems.push({ label: `workflow ${runM[1]}`, nested: runM[1] });
            continue;
          }
          const ensureM = body.match(/^ensure\s+([A-Za-z_][A-Za-z0-9_.]*)\(/);
          if (ensureM) {
            constItems.push({ label: `rule ${ensureM[1]}`, nested: ensureM[1] });
          }
        }
      }
      return constItems;
    }
    if (s.type === "return") {
      return [{ label: `return ${exprLabel(s.value)}` }];
    }
    if (s.type === "trivia") {
      return [];
    }
    return [];
  };

  // Add channel-level route declarations as tree nodes.
  for (const ch of mod.channels) {
    if (ch.routes && ch.routes.length > 0) {
      const targetNames = ch.routes.map((r) => r.value).join(", ");
      items.push({ label: `${ch.name} -> ${targetNames}` });
    }
  }

  for (const step of workflow.steps) {
    items.push(...stepToItems(step));
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



