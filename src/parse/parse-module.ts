import { jaiphModule, TopLevelEmitOrder } from "../types";
import { Trivia, createTrivia } from "./trivia";
import { fail, isReservedBuiltinName } from "./core";
import { parseChannelLine } from "./channels";
import { parseImportLine, parseScriptImportLine } from "./imports";
import {
  parseConfigBlock,
  parseScriptBlock,
  parseDefBlock,
  parseTestBlock,
  parseEnvDecl,
} from "./blocks";
import { parsePromptDefBlock } from "./prompt-def";
import { BodyCursor, topLevelKeyword } from "./body-cursor";

// The module parser: the single top-to-bottom scan that turns the source into a
// `jaiphModule` AST plus formatting trivia. A `BodyCursor` over the source
// holds the position; each declaration is dispatched on its leading tokens
// (`topLevelKeyword`), and its parser reads tokens from that position and
// returns the position after the declaration. It lives here (private to the
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
  const mod: jaiphModule = {
    filePath,
    imports: [],
    channels: [],
    exports: [],
    scripts: [],
    defs: [],
  };
  const topLevelOrder: TopLevelEmitOrder[] = [];
  // Line endings are `\n` from here on: a `\r` before a newline is dropped.
  const cursor = BodyCursor.of(filePath, source.replace(/\r\n/g, "\n"));
  let at = 0;
  let pendingTopLevelComments: string[] = [];

  while (!cursor.atEnd(at)) {
    const start = at;
    const lineNo = cursor.lineNo(start);
    const raw = cursor.text(start);
    const toks = cursor.lineTokensOf(start);
    const head = toks[0];
    at = cursor.next(start);

    if (!head) {
      continue;
    }

    if (head.kind === "other" && head.text === "#") {
      if (lineNo === 1 && raw[head.col] === "!") continue;
      pendingTopLevelComments.push(raw.trim());
      continue;
    }

    const kw = topLevelKeyword(toks, raw);

    if (kw === "config") {
      if (mod.metadata !== undefined) {
        fail(filePath, "duplicate config block (only one allowed per file)", lineNo, 1);
      }
      if (pendingTopLevelComments.length > 0) {
        trivia.setModule({ configLeadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      const { metadata, next } = parseConfigBlock(cursor, start, trivia);
      mod.metadata = metadata;
      at = next;
      continue;
    }

    if (kw === "import script") {
      const si = parseScriptImportLine(filePath, raw, lineNo, toks);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(si, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      if (!mod.scriptImports) mod.scriptImports = [];
      mod.scriptImports.push(si);
      continue;
    }

    if (kw === "import") {
      const imp = parseImportLine(filePath, raw, lineNo, toks);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(imp, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      mod.imports.push(imp);
      continue;
    }

    if (kw === "channel") {
      const ch = parseChannelLine(filePath, raw, lineNo, toks);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(ch, { leadingComments: [...pendingTopLevelComments] });
        pendingTopLevelComments = [];
      }
      mod.channels.push(ch);
      continue;
    }

    if (kw === "test") {
      if (!filePath.endsWith(".test.jh")) {
        fail(filePath, "test blocks belong in *.test.jh files; rename the file or remove the test block", lineNo);
      }
      if (!mod.tests) {
        mod.tests = [];
      }
      const { testBlock, next } = parseTestBlock(cursor, start, trivia);
      if (pendingTopLevelComments.length > 0) {
        trivia.setNode(testBlock, { leadingComments: [...pendingTopLevelComments] });
      }
      pendingTopLevelComments = [];
      mod.tests.push(testBlock);
      topLevelOrder.push({ kind: "test", index: mod.tests.length - 1 });
      at = next;
      continue;
    }

    if (kw === "const") {
      const { envDecl, next } = parseEnvDecl(cursor, start);
      if (pendingTopLevelComments.length > 0) {
        envDecl.comments = [...pendingTopLevelComments];
        pendingTopLevelComments = [];
      }
      if (!mod.envDecls) {
        mod.envDecls = [];
      }
      mod.envDecls.push(envDecl);
      topLevelOrder.push({ kind: "env", index: mod.envDecls.length - 1 });
      at = next;
      continue;
    }

    if (kw === "rule" || kw === "workflow") {
      fail(filePath, `'${kw}' is not a keyword; use 'def'`, lineNo);
    }

    if (kw === "script") {
      const { scriptDef, next, exported } = parseScriptBlock(cursor, start, pendingTopLevelComments, trivia);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(scriptDef.name);
      }
      mod.scripts.push(scriptDef);
      topLevelOrder.push({ kind: "script", index: mod.scripts.length - 1 });
      at = next;
      continue;
    }

    if (kw === "prompt") {
      const { promptDef, next, exported } = parsePromptDefBlock(cursor, start, pendingTopLevelComments, trivia);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(promptDef.name);
      }
      if (!mod.prompts) mod.prompts = [];
      mod.prompts.push(promptDef);
      topLevelOrder.push({ kind: "prompt", index: mod.prompts.length - 1 });
      at = next;
      continue;
    }

    if (kw === "def") {
      const { def, next, exported } = parseDefBlock(cursor, start, pendingTopLevelComments, trivia);
      pendingTopLevelComments = [];
      if (exported) {
        mod.exports.push(def.name);
      }
      mod.defs.push(def);
      topLevelOrder.push({ kind: "def", index: mod.defs.length - 1 });
      at = next;
      continue;
    }

    fail(filePath, `unsupported top-level statement: ${raw.trim()}`, lineNo);
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
    { items: (mod.prompts ?? []).map((p) => ({ name: p.name, loc: p.loc })), kind: "prompt" },
    { items: mod.defs.map((w) => ({ name: w.name, loc: w.loc })), kind: "def" },
    { items: (mod.envDecls ?? []).map((e) => ({ name: e.name, loc: e.loc })), kind: "const" },
  ];
  // A builtin record name (e.g. `module`) is reserved: no declaration may bind
  // it. Checked across imports plus every namespace group, before the dedup pass
  // so the reserved-name error wins over a same-name collision message.
  const bindings: Array<{ name: string; loc: { line: number; col: number }; kind: string }> = [
    ...mod.imports.map((im) => ({ name: im.alias, loc: im.loc, kind: "import alias" })),
    ...groups.flatMap((g) => g.items.map((it) => ({ name: it.name, loc: it.loc, kind: g.kind }))),
  ];
  for (const { name, loc, kind } of bindings) {
    if (isReservedBuiltinName(name)) {
      fail(filePath, `"${name}" is a reserved builtin record and cannot be used as a ${kind} name`, loc.line, loc.col);
    }
  }

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
