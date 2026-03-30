import type { ScriptDef } from "../types";
import { braceDepthDelta, fail, stripQuotes } from "./core";
import { scriptShebangIsBash } from "./script-bash";

function assertAllowedScriptLine(filePath: string, lineNo: number, cmd: string): void {
  const t = cmd.trim();
  if (!t || t.startsWith("#")) return;
  const ret = t.match(/^return\s+(.+)$/s);
  if (ret) {
    const arg = ret[1].trim();
    const isBashExitCode =
      /^[0-9]+$/.test(arg) ||
      arg === "$?" ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(arg);
    if (!isBashExitCode) {
      fail(filePath, 'return "value" is not allowed in script bodies; use stdout (echo) for values', lineNo);
    }
  }
  if (/^\s*(run|ensure)\s/.test(t)) {
    fail(
      filePath,
      "script body cannot use run or ensure (move orchestration to a workflow)",
      lineNo,
    );
  }
  if (/^\s*fail\s/.test(t)) {
    fail(filePath, 'fail is not allowed in script bodies; use return 1 or exit 1', lineNo);
  }
  if (/^\s*const\s/.test(t)) {
    fail(filePath, 'const is not allowed in script bodies; use bash local', lineNo);
  }
  if (/^\s*log\s/.test(t) || /^\s*logerr\s/.test(t)) {
    fail(filePath, "log/logerr are not allowed in script bodies; use echo or echo >&2", lineNo);
  }
  if (/^\s*prompt(\s|$)/.test(t)) {
    fail(filePath, "prompt is not allowed in script bodies", lineNo);
  }
}

function finalizeScriptBody(filePath: string, scriptDef: ScriptDef): void {
  while (scriptDef.commands.length > 0 && scriptDef.commands[0].trim() === "") {
    scriptDef.commands.shift();
  }
  if (scriptDef.commands.length > 0) {
    const first = scriptDef.commands[0];
    const firstLine = first.split("\n")[0].trim();
    if (firstLine.startsWith("#!")) {
      scriptDef.shebang = firstLine;
      const nl = first.indexOf("\n");
      const rest = nl === -1 ? "" : first.slice(nl + 1);
      scriptDef.commands.shift();
      if (rest.trim()) {
        scriptDef.commands.unshift(rest.trimEnd());
      }
    }
  }
  const bash = scriptShebangIsBash(scriptDef.shebang);
  if (!bash) return;
  scriptDef.commands = scriptDef.commands.map((c) => stripQuotes(c));
  const lineNo = scriptDef.loc.line;
  for (const cmd of scriptDef.commands) {
    if (!cmd.trim()) continue;
    assertAllowedScriptLine(filePath, lineNo, cmd);
  }
}

export function parseScriptBlock(
  filePath: string,
  lines: string[],
  startIndex: number,
  pendingComments: string[],
): { scriptDef: ScriptDef; nextIndex: number } {
  const lineNo = startIndex + 1;
  const raw = lines[startIndex];
  const line = raw.trim();

  const match = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  if (!match) {
    const parensMatch = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (parensMatch) {
      fail(
        filePath,
        `definitions must not use parentheses: script ${parensMatch[1]} { … }`,
        lineNo,
      );
    }
    const loose = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      fail(
        filePath,
        `script declarations require braces: script ${loose[1]} { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid script declaration", lineNo);
  }
  const scriptDef: ScriptDef = {
    name: match[1],
    comments: pendingComments,
    commands: [],
    loc: { line: lineNo, col: 1 },
  };

  let i = startIndex + 1;
  let braceDepth = 0;
  let currentCommandLines: string[] = [];
  let pendingCmdStartLine = lineNo;

  const pushCmdLine = (s: string, startLine: number): void => {
    if (currentCommandLines.length === 0) pendingCmdStartLine = startLine;
    currentCommandLines.push(s);
  };

  const flushCommand = (): void => {
    if (currentCommandLines.length === 0) return;
    const cmd = currentCommandLines.join("\n").trim();
    currentCommandLines = [];
    if (!cmd) return;
    scriptDef.commands.push(cmd);
  };

  for (; i < lines.length; i += 1) {
    const innerNo = i + 1;
    const innerRaw = lines[i];
    const inner = innerRaw.trim();
    if (!inner) {
      if (braceDepth > 0) pushCmdLine(innerRaw, innerNo);
      else flushCommand();
      continue;
    }
    if (inner.startsWith("#")) {
      if (braceDepth > 0) pushCmdLine(innerRaw, innerNo);
      else {
        flushCommand();
        scriptDef.commands.push(innerRaw.trim());
      }
      continue;
    }
    if (inner === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
      pushCmdLine(innerRaw.trim(), innerNo);
      if (braceDepth === 0) flushCommand();
      continue;
    }
    if (braceDepth > 0) {
      pushCmdLine(innerRaw.trim(), innerNo);
      braceDepth += braceDepthDelta(inner);
      if (braceDepth === 0) flushCommand();
      continue;
    }
    const delta = braceDepthDelta(inner);
    if (delta > 0) {
      pushCmdLine(innerRaw.trim(), innerNo);
      braceDepth = delta;
      if (braceDepth === 0) flushCommand();
      continue;
    }
    const cmd = inner;
    if (!cmd) {
      fail(filePath, "script command is required", innerNo);
    }
    scriptDef.commands.push(cmd);
  }
  flushCommand();
  if (i >= lines.length) {
    fail(filePath, `unterminated script block: ${scriptDef.name}`, lineNo);
  }
  finalizeScriptBody(filePath, scriptDef);
  return { scriptDef, nextIndex: i + 1 };
}
