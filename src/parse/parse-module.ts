import { jaiphModule, TopLevelEmitOrder } from "../types";
import { Trivia, createTrivia } from "./trivia";
import { fail } from "./core";
import { parseChannelLine } from "./channels";
import { parseImportLine, parseScriptImportLine } from "./imports";
import {
  parseConfigBlock,
  parseScriptBlock,
  parseDefBlock,
  parseTestBlock,
  parseEnvDecl,
} from "./blocks";

// The module parser: the single top-to-bottom scan that turns source lines into
// a `jaiphModule` AST plus formatting trivia. It lives here (private to the
// parse package) so the public entry `src/parser.ts` stays a curated facade;
// outside code still imports `parsejaiph` / `parsejaiphWithTrivia` from there.

export interface ParseResult {
  ast: jaiphModule;
  trivia: Trivia;
}

export function parsejaiph(source: string, filePath: string): jaiphModule {
  return parsejaiphWithTrivia(source, filePath).ast;
}

export function parsejaiphWithTrivia(source: string, filePath: string): ParseResult {
  const trivia = createTrivia();
  const lines = source.split(/\r?\n/);
  const mod: jaiphModule = {
    filePath,
    imports: [],
    channels: [],
    exports: [],
    scripts: [],
    defs: [],
  };
  const topLevelOrder: TopLevelEmitOrder[] = [];
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
        trivia.setModule({ configLeadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      const { metadata, nextIndex } = parseConfigBlock(filePath, lines, i - 1, trivia);
      mod.metadata = metadata;
      i = nextIndex;
      continue;
    }

    if (line.startsWith("import script ")) {
      const si = parseScriptImportLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(si, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      if (!mod.scriptImports) mod.scriptImports = [];
      mod.scriptImports.push(si);
      continue;
    }

    if (line.startsWith("import ")) {
      const imp = parseImportLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(imp, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      mod.imports.push(imp);
      continue;
    }

    if (line.startsWith("channel ")) {
      const ch = parseChannelLine(filePath, line, raw, lineNo);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(ch, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      mod.channels.push(ch);
      continue;
    }

    if (line.startsWith("test ")) {
      if (!filePath.endsWith(".test.jh")) {
        fail(filePath, "test blocks belong in *.test.jh files; rename the file or remove the test block", lineNo);
      }
      if (!mod.tests) {
        mod.tests = [];
      }
      const { testBlock, nextIndex } = parseTestBlock(
        filePath,
        lines,
        i - 1,
        trivia,
      );
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(testBlock, { leadingComments: [...pendingTopLevelComments] });
      }
      pendingTopLevelComments = [];
      mod.tests.push(testBlock);
      topLevelOrder.push({ kind: "test", index: mod.tests.length - 1 });
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
      topLevelOrder.push({ kind: "env", index: mod.envDecls.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^(export\s+)?(rule|workflow)\s/.test(line)) {
      const kind = /(?:export\s+)?(rule|workflow)\s/.exec(line)?.[1] ?? "rule";
      fail(filePath, `'${kind}' is not a keyword; use 'def'`, lineNo);
    }

    if (/^(export\s+)?script\s/.test(line)) {
      const { scriptDef, nextIndex, exported } = parseScriptBlock(filePath, lines, i - 1, pendingTopLevelComments, trivia);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(scriptDef.name);
      }
      mod.scripts.push(scriptDef);
      topLevelOrder.push({ kind: "script", index: mod.scripts.length - 1 });
      i = nextIndex;
      continue;
    }

    if (/^(export\s+)?def\s/.test(line)) {
      const { def, nextIndex, exported } = parseDefBlock(filePath, lines, i - 1, pendingTopLevelComments, trivia);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(def.name);
      }
      mod.defs.push(def);
      topLevelOrder.push({ kind: "def", index: mod.defs.length - 1 });
      i = nextIndex;
      continue;
    }

    fail(filePath, `unsupported top-level statement: ${line}`, lineNo);
  }

  trivia.setModule({ topLevelOrder });
  if (pendingTopLevelComments.length > 0) {
    trivia.setModule({ trailingTopLevelComments: [...pendingTopLevelComments] });
  }

  // Unified namespace: imports, channels, defs, scripts, and consts share one name space.
  const seen = new Map<string, string>();
  const groups: Array<{ items: Array<{ name: string; loc: { line: number; col: number } }>; kind: string }> = [
    { items: (mod.scriptImports ?? []).map((si) => ({ name: si.alias, loc: si.loc })), kind: "script import" },
    { items: mod.channels.map((c) => ({ name: c.name, loc: c.loc })), kind: "channel" },
    { items: mod.scripts.map((s) => ({ name: s.name, loc: s.loc })), kind: "script" },
    { items: mod.defs.map((w) => ({ name: w.name, loc: w.loc })), kind: "def" },
    { items: (mod.envDecls ?? []).map((e) => ({ name: e.name, loc: e.loc })), kind: "const" },
  ];
  for (const { items, kind } of groups) {
    for (const { name, loc } of items) {
      const prev = seen.get(name);
      if (prev) {
        const msg = kind === "const"
          ? `duplicate name "${name}" — variable name collides with ${prev} of the same name`
          : `duplicate name "${name}" — channels, defs, and scripts share a single namespace (already declared as ${prev})`;
        fail(filePath, msg, loc.line, loc.col);
      }
      seen.set(name, kind);
    }
  }

  return { ast: mod, trivia };
}
