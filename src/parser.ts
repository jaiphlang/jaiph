import { FunctionDef, jaiphModule, RuleDef, WorkflowDef } from "./types";
import { jaiphError } from "./errors";

function fail(filePath: string, message: string, lineNo: number, col = 1): never {
  throw jaiphError(filePath, lineNo, col, "E_PARSE", message);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isRef(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(value);
}

function hasUnescapedClosingQuote(text: string, startIndex: number): boolean {
  for (let i = startIndex; i < text.length; i += 1) {
    if (text[i] === `"` && text[i - 1] !== `\\`) {
      return true;
    }
  }
  return false;
}

export function parsejaiph(source: string, filePath: string): jaiphModule {
  const lines = source.split(/\r?\n/);
  const mod: jaiphModule = { filePath, imports: [], exports: [], rules: [], functions: [], workflows: [] };
  let i = 0;
  let pendingTopLevelComments: string[] = [];

  const openRule = (name: string, line: number): RuleDef => ({
    name,
    comments: [],
    commands: [],
    loc: { line, col: 1 },
  });
  const openWorkflow = (name: string, line: number): WorkflowDef => ({
    name,
    comments: [],
    steps: [],
    loc: { line, col: 1 },
  });
  const openFunction = (name: string, line: number): FunctionDef => ({
    name,
    comments: [],
    commands: [],
    loc: { line, col: 1 },
  });

  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    i += 1;

    if (!line) {
      pendingTopLevelComments = [];
      continue;
    }

    if (lineNo === 1 && line.startsWith("#!")) {
      continue;
    }

    if (line.startsWith("#")) {
      pendingTopLevelComments.push(line);
      continue;
    }

    if (line.startsWith("import ")) {
      pendingTopLevelComments = [];
      const match = line.match(/^import\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!match) {
        fail(filePath, 'import must match: import "<path>" as <alias>', lineNo);
      }
      mod.imports.push({
        path: stripQuotes(match[1]),
        alias: match[2],
        loc: { line: lineNo, col: raw.indexOf("import") + 1 },
      });
      continue;
    }

    if (line.includes("rule ")) {
      const match = line.match(/^(export\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
      if (!match) {
        fail(filePath, "invalid rule declaration", lineNo);
      }
      const isExported = Boolean(match[1]);
      const rule = openRule(match[2], lineNo);
      rule.comments = pendingTopLevelComments;
      pendingTopLevelComments = [];
      if (isExported) {
        mod.exports.push(rule.name);
      }
      for (; i < lines.length; i += 1) {
        const innerNo = i + 1;
        const innerRaw = lines[i];
        const inner = innerRaw.trim();
        if (!inner) {
          continue;
        }
        if (inner === "}") {
          break;
        }
        if (inner.startsWith("#")) {
          rule.commands.push(innerRaw.trim());
          continue;
        }
        if (inner.startsWith("run ")) {
          fail(
            filePath,
            "`run` is not allowed inside a `rule` block.\nUse `ensure` to call another rule, or move this call to a `workflow`.",
            innerNo,
            innerRaw.indexOf("run") + 1,
          );
        }
        const cmd = inner;
        if (!cmd) {
          fail(filePath, "rule command is required", innerNo);
        }
        rule.commands.push(stripQuotes(cmd));
      }
      if (i >= lines.length) {
        fail(filePath, `unterminated rule block: ${rule.name}`, lineNo);
      }
      i += 1;
      mod.rules.push(rule);
      continue;
    }

    if (line.includes("function ")) {
      const match = line.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?\s*\{$/);
      if (!match) {
        fail(filePath, "invalid function declaration", lineNo);
      }
      const fn = openFunction(match[1], lineNo);
      fn.comments = pendingTopLevelComments;
      pendingTopLevelComments = [];
      for (; i < lines.length; i += 1) {
        const innerNo = i + 1;
        const innerRaw = lines[i];
        const inner = innerRaw.trim();
        if (!inner) {
          continue;
        }
        if (inner === "}") {
          break;
        }
        if (inner.startsWith("#")) {
          fn.commands.push(innerRaw.trim());
          continue;
        }
        const cmd = inner.startsWith("run ") ? inner.slice("run ".length).trim() : inner;
        if (!cmd) {
          fail(filePath, "function command is required", innerNo);
        }
        fn.commands.push(stripQuotes(cmd));
      }
      if (i >= lines.length) {
        fail(filePath, `unterminated function block: ${fn.name}`, lineNo);
      }
      i += 1;
      mod.functions.push(fn);
      continue;
    }

    if (line.includes("workflow ")) {
      const match = line.match(/^(export\s+)?workflow\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
      if (!match) {
        fail(filePath, "invalid workflow declaration", lineNo);
      }
      const isExported = Boolean(match[1]);
      const workflow = openWorkflow(match[2], lineNo);
      workflow.comments = pendingTopLevelComments;
      pendingTopLevelComments = [];
      if (isExported) {
        mod.exports.push(workflow.name);
      }

      for (; i < lines.length; i += 1) {
        const innerNo = i + 1;
        const innerRaw = lines[i];
        const inner = innerRaw.trim();
        if (!inner) {
          continue;
        }
        if (inner === "}") {
          break;
        }
        if (inner.startsWith("#")) {
          workflow.steps.push({
            type: "shell",
            command: innerRaw.trim(),
            loc: { line: innerNo, col: 1 },
          });
          continue;
        }

        const ifEnsureMatch = inner.match(
          /^if\s+!\s*ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*;\s*then$/,
        );
        if (ifEnsureMatch) {
          const ensureRef = ifEnsureMatch[1];
          const thenStart = i + 1;
          let runLine = -1;
          let fiLine = -1;
          const shellCommands: Array<{ command: string; loc: { line: number; col: number } }> = [];
          for (let lookahead = i + 1; lookahead < lines.length; lookahead += 1) {
            const lookNo = lookahead + 1;
            const lookRaw = lines[lookahead];
            const lookTrim = lookRaw.trim();
            if (!lookTrim || lookTrim.startsWith("#")) {
              continue;
            }
            if (lookTrim === "fi") {
              fiLine = lookahead;
              break;
            }
            const runMatch = lookTrim.match(
              /^run\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/,
            );
            if (runMatch && shellCommands.length === 0) {
              runLine = lookahead;
              let foundFi = -1;
              for (let f = lookahead + 1; f < lines.length; f += 1) {
                const ft = lines[f].trim();
                if (!ft || ft.startsWith("#")) continue;
                if (ft === "fi") {
                  foundFi = f;
                  break;
                }
                fail(filePath, 'if-block must end with "fi"', f + 1);
              }
              if (foundFi === -1) {
                fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
              }
              workflow.steps.push({
                type: "if_not_ensure_then_run",
                ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
                runWorkflow: {
                  value: lines[runLine].trim().slice("run ".length).trim(),
                  loc: { line: runLine + 1, col: lines[runLine].indexOf("run") + 1 },
                },
              });
              i = foundFi;
              break;
            }
            shellCommands.push({
              command: lookTrim,
              loc: { line: lookNo, col: (lookRaw.match(/\S/)?.index ?? 0) + 1 },
            });
          }
          if (fiLine === -1 && runLine === -1) {
            fail(filePath, 'unterminated if-block, expected "fi"', innerNo);
          }
          if (runLine === -1 && fiLine >= 0) {
            workflow.steps.push({
              type: "if_not_ensure_then_shell",
              ensureRef: { value: ensureRef, loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 } },
              commands: shellCommands,
            });
            i = fiLine;
          }
          continue;
        }

        if (inner.startsWith("prompt ")) {
          const promptCol = innerRaw.indexOf("prompt") + 1;
          const promptArg = innerRaw.slice(innerRaw.indexOf("prompt") + "prompt".length).trimStart();
          if (!promptArg.startsWith(`"`)) {
            fail(filePath, 'prompt must match: prompt "<text>"', innerNo, promptCol);
          }
          let rawPrompt = promptArg;
          if (!hasUnescapedClosingQuote(promptArg, 1)) {
            let closed = false;
            for (let lookahead = i + 1; lookahead < lines.length; lookahead += 1) {
              rawPrompt += `\n${lines[lookahead]}`;
              if (hasUnescapedClosingQuote(lines[lookahead], 0)) {
                i = lookahead;
                closed = true;
                break;
              }
            }
            if (!closed) {
              fail(filePath, "unterminated prompt string", innerNo, promptCol);
            }
          }
          workflow.steps.push({
            type: "prompt",
            raw: rawPrompt,
            loc: { line: innerNo, col: promptCol },
          });
          continue;
        }

        if (inner.startsWith("ensure ")) {
          const ensureBody = inner.slice("ensure ".length).trim();
          const ensureMatch = ensureBody.match(
            /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
          );
          if (!ensureMatch || !isRef(ensureMatch[1])) {
            fail(filePath, "invalid ensure statement", innerNo);
          }
          const ref = ensureMatch[1];
          const args = ensureMatch[2]?.trim();
          workflow.steps.push({
            type: "ensure",
            ref: {
              value: ref,
              loc: { line: innerNo, col: innerRaw.indexOf("ensure") + 1 },
            },
            args,
          });
          continue;
        }

        if (inner.startsWith("run ")) {
          const workflowRef = inner.slice("run ".length).trim();
          if (!isRef(workflowRef)) {
            fail(filePath, "run must target a workflow reference", innerNo);
          }
          workflow.steps.push({
            type: "run",
            workflow: {
              value: workflowRef,
              loc: { line: innerNo, col: innerRaw.indexOf("run") + 1 },
            },
          });
          continue;
        }

        workflow.steps.push({
          type: "shell",
          command: inner,
          loc: { line: innerNo, col: 1 },
        });
      }

      if (i >= lines.length) {
        fail(filePath, `unterminated workflow block: ${workflow.name}`, lineNo);
      }
      i += 1;
      mod.workflows.push(workflow);
      continue;
    }

    fail(filePath, `unsupported top-level statement: ${line}`, lineNo);
  }

  return mod;
}
