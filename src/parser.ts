import { jaiphModule } from "./types";
import { fail } from "./parse/core";
import { parseChannelLine } from "./parse/channels";
import { parseEnvDecl } from "./parse/env";
import { parseImportLine } from "./parse/imports";
import { parseConfigBlock } from "./parse/metadata";
import { parseRuleBlock } from "./parse/rules";
import { parseFunctionBlock } from "./parse/functions";
import { parseWorkflowBlock } from "./parse/workflows";
import { parseTestBlock } from "./parse/tests";

export function parsejaiph(source: string, filePath: string): jaiphModule {
  const lines = source.split(/\r?\n/);
  const mod: jaiphModule = { filePath, imports: [], channels: [], exports: [], rules: [], functions: [], workflows: [] };
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

    if (/^config\s*\{/.test(line)) {
      if (mod.metadata !== undefined) {
        fail(filePath, "duplicate config block (only one allowed per file)", lineNo, 1);
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, i - 1);
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

    if (line.startsWith("channel ")) {
      pendingTopLevelComments = [];
      mod.channels.push(parseChannelLine(filePath, line, raw, lineNo));
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

    if (/^(?:local|const)\s+[A-Za-z_]/.test(line)) {
      pendingTopLevelComments = [];
      const { envDecl, nextIndex } = parseEnvDecl(filePath, lines, i - 1);
      if (!mod.envDecls) {
        mod.envDecls = [];
      }
      mod.envDecls.push(envDecl);
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

  // Unified namespace: rules, workflows, and functions share a single name space.
  const seen = new Map<string, string>();
  for (const ch of mod.channels) {
    const prev = seen.get(ch.name);
    if (prev) {
      fail(
        filePath,
        `duplicate name "${ch.name}" — channels, rules, workflows, and functions share a single namespace (already declared as ${prev})`,
        ch.loc.line,
        ch.loc.col,
      );
    }
    seen.set(ch.name, "channel");
  }
  for (const r of mod.rules) {
    const prev = seen.get(r.name);
    if (prev) {
      fail(filePath, `duplicate name "${r.name}" — rules, workflows, and functions share a single namespace (already declared as ${prev})`, r.loc.line, r.loc.col);
    }
    seen.set(r.name, "rule");
  }
  for (const fn of mod.functions) {
    const prev = seen.get(fn.name);
    if (prev) {
      fail(filePath, `duplicate name "${fn.name}" — rules, workflows, and functions share a single namespace (already declared as ${prev})`, fn.loc.line, fn.loc.col);
    }
    seen.set(fn.name, "function");
  }
  for (const w of mod.workflows) {
    const prev = seen.get(w.name);
    if (prev) {
      fail(filePath, `duplicate name "${w.name}" — rules, workflows, and functions share a single namespace (already declared as ${prev})`, w.loc.line, w.loc.col);
    }
    seen.set(w.name, "workflow");
  }
  if (mod.envDecls) {
    for (const env of mod.envDecls) {
      const prev = seen.get(env.name);
      if (prev) {
        fail(filePath, `duplicate name "${env.name}" — variable name collides with ${prev} of the same name`, env.loc.line, env.loc.col);
      }
      seen.set(env.name, "local");
    }
  }

  return mod;
}
