import { jaiphModule } from "./types";
import { fail } from "./parse/core";
import { parseImportLine } from "./parse/imports";
import { parseMetadataBlock } from "./parse/metadata";
import { parseRuleBlock } from "./parse/rules";
import { parseFunctionBlock } from "./parse/functions";
import { parseWorkflowBlock } from "./parse/workflows";
import { parseTestBlock } from "./parse/tests";

export function parsejaiph(source: string, filePath: string): jaiphModule {
  const lines = source.split(/\r?\n/);
  const mod: jaiphModule = { filePath, imports: [], exports: [], rules: [], functions: [], workflows: [] };
  let i = 0;
  let pendingTopLevelComments: string[] = [];

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

    if (line.startsWith("metadata ") && line.includes("{")) {
      if (mod.metadata !== undefined) {
        fail(filePath, "duplicate metadata block (only one allowed per file)", lineNo, 1);
      }
      const { metadata, nextIndex } = parseMetadataBlock(filePath, lines, i - 1);
      mod.metadata = metadata;
      i = nextIndex;
      pendingTopLevelComments = [];
      continue;
    }

    if (line.startsWith("import ")) {
      pendingTopLevelComments = [];
      mod.imports.push(parseImportLine(filePath, line, raw, lineNo));
      continue;
    }

    const isTestFile = filePath.endsWith(".test.jh") || filePath.endsWith(".test.jph");
    if (isTestFile && line.startsWith("test ")) {
      if (!mod.tests) {
        mod.tests = [];
      }
      const { testBlock, nextIndex } = parseTestBlock(filePath, lines, i - 1);
      mod.tests.push(testBlock);
      i = nextIndex;
      continue;
    }

    if (line.includes("rule ")) {
      const { rule, nextIndex, exported } = parseRuleBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(rule.name);
      }
      mod.rules.push(rule);
      i = nextIndex;
      continue;
    }

    if (line.includes("function ")) {
      const { fn, nextIndex } = parseFunctionBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      mod.functions.push(fn);
      i = nextIndex;
      continue;
    }

    if (line.includes("workflow ")) {
      const { workflow, nextIndex, exported } = parseWorkflowBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(workflow.name);
      }
      mod.workflows.push(workflow);
      i = nextIndex;
      continue;
    }

    fail(filePath, `unsupported top-level statement: ${line}`, lineNo);
  }

  return mod;
}
