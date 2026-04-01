import type { ScriptDef } from "../types";
import { braceDepthDelta, fail } from "./core";

/** Built-in interpreter tags for `script:<tag>` sugar. Tag → shebang line. */
export const INTERPRETER_TAGS: Record<string, string> = {
  node: "#!/usr/bin/env node",
  python3: "#!/usr/bin/env python3",
  ruby: "#!/usr/bin/env ruby",
  perl: "#!/usr/bin/env perl",
  pwsh: "#!/usr/bin/env pwsh",
  deno: "#!/usr/bin/env deno run",
  bash: "#!/usr/bin/env bash",
};
function finalizeScriptBody(scriptDef: ScriptDef, filePath: string): void {
  while (scriptDef.commands.length > 0 && scriptDef.commands[0].trim() === "") {
    scriptDef.commands.shift();
  }
  if (scriptDef.commands.length > 0) {
    const first = scriptDef.commands[0];
    const firstLine = first.split("\n")[0].trim();
    if (firstLine.startsWith("#!")) {
      if (scriptDef.interpreterTag) {
        fail(
          filePath,
          `script:${scriptDef.interpreterTag} already sets the shebang — remove the manual "#!" line`,
          scriptDef.loc.line,
        );
      }
      scriptDef.shebang = firstLine;
      const nl = first.indexOf("\n");
      const rest = nl === -1 ? "" : first.slice(nl + 1);
      scriptDef.commands.shift();
      if (rest.trim()) {
        scriptDef.commands.unshift(rest.trimEnd());
      }
    }
  }
  // Apply interpreter tag shebang
  if (scriptDef.interpreterTag) {
    scriptDef.shebang = INTERPRETER_TAGS[scriptDef.interpreterTag];
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

  // Match `script name {` or `script:tag name {`
  const taggedMatch = line.match(/^script:([a-zA-Z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  const plainMatch = line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
  const match = taggedMatch ?? plainMatch;
  if (!match) {
    // Check for tagged form with bad syntax
    const taggedParens = line.match(/^script:([a-zA-Z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const parensMatch = taggedParens ?? line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (parensMatch) {
      const name = taggedParens ? parensMatch[2] : parensMatch[1];
      fail(
        filePath,
        `definitions must not use parentheses: script ${name} { … }`,
        lineNo,
      );
    }
    // Check for unknown tag
    const unknownTag = line.match(/^script:([a-zA-Z0-9_]+)\s/);
    if (unknownTag && !(unknownTag[1] in INTERPRETER_TAGS)) {
      const validTags = Object.keys(INTERPRETER_TAGS).join(", ");
      fail(
        filePath,
        `unknown interpreter tag "script:${unknownTag[1]}" — supported tags: ${validTags}`,
        lineNo,
      );
    }
    const taggedLoose = line.match(/^script:([a-zA-Z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const loose = taggedLoose ?? line.match(/^script\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (loose) {
      const name = taggedLoose ? loose[2] : loose[1];
      fail(
        filePath,
        `script declarations require braces: script ${name} { … }`,
        lineNo,
      );
    }
    fail(filePath, "invalid script declaration", lineNo);
  }

  const interpreterTag = taggedMatch ? taggedMatch[1] : undefined;
  const scriptName = taggedMatch ? taggedMatch[2] : match[1];

  // Validate interpreter tag
  if (interpreterTag && !(interpreterTag in INTERPRETER_TAGS)) {
    const validTags = Object.keys(INTERPRETER_TAGS).join(", ");
    fail(
      filePath,
      `unknown interpreter tag "script:${interpreterTag}" — supported tags: ${validTags}`,
      lineNo,
    );
  }

  const scriptDef: ScriptDef = {
    name: scriptName,
    comments: pendingComments,
    commands: [],
    loc: { line: lineNo, col: 1 },
    ...(interpreterTag ? { interpreterTag } : {}),
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
  finalizeScriptBody(scriptDef, filePath);
  return { scriptDef, nextIndex: i + 1 };
}
