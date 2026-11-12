import type { NodeTrivia, Trivia } from "../parser";
import type { Arg } from "../types";

// Small formatter helpers shared by the module/declaration emitter (`emit.ts`)
// and the step/expression emitter (`emit-steps.ts`). Kept in a dependency-free
// leaf so those two files can share them without an import cycle.

export function tn(trivia: Trivia, node: object): NodeTrivia {
  return trivia.getNode(node) ?? {};
}

export function emitComments(comments: string[]): string[] {
  return comments.map((c) => (c.startsWith("#") ? c : `# ${c}`));
}

export function emitCommentBlock(comments: string[]): string {
  return emitComments(comments).join("\n");
}

/**
 * Format a call's argument list. A multi-line literal (from a `"""` argument)
 * is written back as a `"""` block opening on the call line — writing it as a
 * single-line `"…"` would put a raw newline inside a one-line string. Body
 * lines get `bodyIndent`; the closing `"""` gets `closeIndent`.
 */
export function formatArgs(args: Arg[] | undefined, closeIndent = "", bodyIndent = closeIndent): string {
  if (!args || args.length === 0) return "";
  return args
    .map((a) => {
      if (a.kind === "var") return a.name;
      if (a.raw.startsWith('"') && a.raw.includes("\n")) {
        const body = decodeTripleQuotedInner(a.raw)
          .split("\n")
          .map((l) => (l ? `${bodyIndent}${l}` : ""));
        return ['"""', ...body, `${closeIndent}"""`].join("\n");
      }
      return a.raw;
    })
    .join(", ");
}

/** Re-indent a dedented fenced script body for readable `.jh` output. */
export function emitFencedScriptBodyLines(body: string, lineIndent: string): string[] {
  return body.split("\n").map((line) => (line.length === 0 ? "" : `${lineIndent}${line}`));
}

/**
 * Decode a double-quoted literal's `raw` back to the inner body of its
 * triple-quoted (`"""…"""`) source form: strip the outer quotes and undo the
 * `\"` / `\\` escaping the parser applied. Used only as the fallback when
 * `trivia.rawBody` (the verbatim original body) is absent.
 */
export function decodeTripleQuotedInner(raw: string): string {
  return raw.slice(1, -1).replace(/\\"/g, '"');
}

export function emitRef(
  ref: { value: string },
  args: Arg[] | undefined,
  closeIndent = "",
  bodyIndent = closeIndent,
): string {
  return `${ref.value}(${formatArgs(args, closeIndent, bodyIndent)})`;
}
