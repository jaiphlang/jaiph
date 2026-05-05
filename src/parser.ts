import { jaiphModule } from "./types";
import { fail } from "./parse/core";
import { parseChannelLine } from "./parse/channels";
import { parseEnvDecl } from "./parse/env";
import { parseImportLine, parseScriptImportLine } from "./parse/imports";
import { parseConfigBlock } from "./parse/metadata";
import { parseRuleBlock } from "./parse/rules";
import { parseScriptBlock } from "./parse/scripts";
import { parseWorkflowBlock } from "./parse/workflows";
import { parseTestBlock } from "./parse/tests";

export function parsejaiph(source: string, filePath: string): jaiphModule {
  const lines = source.split(/\r?\n/);
  const mod: jaiphModule = {
    filePath,
    imports: [],
    channels: [],
    exports: [],
    rules: [],
    scripts: [],
    workflows: [],
    topLevelOrder: [],
  };
  let i = 0;
  let pendingTopLevelComments: string[] = [];

  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    i += 1;

    if (!line) {
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
      if (pendingTopLevelComments.length > 0) {
        mod.configLeadingComments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, i - 1);
      mod.metadata = metadata;
      i = nextIndex;
      continue;
    }

    if (line.startsWith("import script ")) {
      const si = parseScriptImportLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        si.leadingComments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      if (!mod.scriptImports) mod.scriptImports = [];
      mod.scriptImports.push(si);
      continue;
    }

    if (line.startsWith("import ")) {
      const imp = parseImportLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        imp.leadingComments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      mod.imports.push(imp);
      continue;
    }

    if (line.startsWith("channel ")) {
      const ch = parseChannelLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        ch.leadingComments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      mod.channels.push(ch);
      continue;
    }

    const isTestFile = filePath.endsWith(".test.jh");
    if (isTestFile && line.startsWith("test ")) {
      if (!mod.tests) {
        mod.tests = [];
      }
      const { testBlock, nextIndex } = parseTestBlock(
        filePath,
        lines,
        i - 1,
        pendingTopLevelComments.length > 0 ? [...pendingTopLevelComments] : undefined,
      );
      pendingTopLevelComments = [];
      mod.tests.push(testBlock);
      mod.topLevelOrder!.push({ kind: "test", index: mod.tests.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^const\s+[A-Za-z_]/.test(line)) {
      const { envDecl, nextIndex } = parseEnvDecl(filePath, lines, i - 1);
      if (pendingTopLevelComments.length > 0) {
        envDecl.comments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      if (!mod.envDecls) {
        mod.envDecls = [];
      }
      mod.envDecls.push(envDecl);
      mod.topLevelOrder!.push({ kind: "env", index: mod.envDecls.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^(export\s+)?rule\s/.test(line)) {
      const { rule, nextIndex, exported } = parseRuleBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(rule.name);
      }
      mod.rules.push(rule);
      mod.topLevelOrder!.push({ kind: "rule", index: mod.rules.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^(export\s+)?script\s/.test(line)) {
      const { scriptDef, nextIndex, exported } = parseScriptBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(scriptDef.name);
      }
      mod.scripts.push(scriptDef);
      mod.topLevelOrder!.push({ kind: "script", index: mod.scripts.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^(export\s+)?workflow\s/.test(line)) {
      const { workflow, nextIndex, exported } = parseWorkflowBlock(filePath, lines, i - 1, pendingTopLevelComments);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(workflow.name);
      }
      mod.workflows.push(workflow);
      mod.topLevelOrder!.push({ kind: "workflow", index: mod.workflows.length - 1 });
      i = nextIndex;
      continue;
    }

    fail(filePath, `unsupported top-level statement: ${line}`, lineNo);
  }

  if (pendingTopLevelComments.length > 0) {
    mod.trailingTopLevelComments = [...pendingTopLevelComments];
  }

  // Unified namespace: imports, channels, rules, workflows, scripts, and consts all share one name space.
  const seen = new Map<string, string>();
  const groups: Array<{ items: Array<{ name: string; loc: { line: number; col: number } }>; kind: string }> = [
    { items: (mod.scriptImports ?? []).map((si) => ({ name: si.alias, loc: si.loc })), kind: "script import" },
    { items: mod.channels.map((c) => ({ name: c.name, loc: c.loc })), kind: "channel" },
    { items: mod.rules.map((r) => ({ name: r.name, loc: r.loc })), kind: "rule" },
    { items: mod.scripts.map((s) => ({ name: s.name, loc: s.loc })), kind: "script" },
    { items: mod.workflows.map((w) => ({ name: w.name, loc: w.loc })), kind: "workflow" },
    { items: (mod.envDecls ?? []).map((e) => ({ name: e.name, loc: e.loc })), kind: "const" },
  ];
  for (const { items, kind } of groups) {
    for (const { name, loc } of items) {
      const prev = seen.get(name);
      if (prev) {
        const msg = kind === "const"
          ? `duplicate name "${name}" — variable name collides with ${prev} of the same name`
          : `duplicate name "${name}" — channels, rules, workflows, and scripts share a single namespace (already declared as ${prev})`;
        fail(filePath, msg, loc.line, loc.col);
      }
      seen.set(name, kind);
    }
  }

  return mod;
}
