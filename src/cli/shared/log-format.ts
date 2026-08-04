import type { SandboxMode } from "../../runtime";

// Pure presentation helpers shared across CLI slices: ANSI colorization, the
// async-branch subscript indent, and the sandbox parenthetical label. They live
// under `src/cli/shared` so both the `run` slice (interactive progress tree) and
// the operator log used by `jaiph mcp` / `jaiph serve` (`shared/server-log.ts`)
// reuse one implementation without a peer-slice import. No side effects — every
// function maps inputs to a string.

export type ColorCode = "dim" | "bold" | "green" | "red" | "yellow" | "blue";

/** Wrap `text` in an SGR color sequence when `colorEnabled`; identity otherwise. */
export function colorize(text: string, code: ColorCode, colorEnabled: boolean): string {
  if (!colorEnabled) return text;
  const prefix =
    code === "dim" ? "\u001b[2m"
    : code === "bold" ? "\u001b[1m"
    : code === "green" ? "\u001b[32m"
    : code === "yellow" ? "\u001b[33m"
    : code === "blue" ? "\u001b[34m"
    : "\u001b[31m";
  return `${prefix}${text}\u001b[0m`;
}

/** Unicode subscript number ₁₂₃… (U+2080–U+2089 per digit). */
function subscriptNumber(n: number): string {
  let result = "";
  for (const d of String(n)) {
    result += String.fromCodePoint(0x2080 + Number(d));
  }
  return result;
}

/**
 * Build an indent string with subscript async-branch numbers embedded.
 * Each depth level is one `"  · "` segment (4 chars). For levels that have
 * an async index, the leading `"  "` is replaced with `" {subscript}"`.
 */
export function buildAsyncIndent(depth: number, asyncIndices: number[]): string {
  if (asyncIndices.length === 0) return "  · ".repeat(depth);
  let result = "";
  for (let i = 0; i < depth; i++) {
    const head = i < asyncIndices.length ? ` ${subscriptNumber(asyncIndices[i])}` : "  ";
    result += `${head}· `;
  }
  return result;
}

/**
 * The sandbox parenthetical shared by the `jaiph run` banner and the operator
 * log per-call lines: `snapshot` / `in-place` (Docker), `Docker sandbox, unsafe`
 * (host-only via the unsafe opt-in), or `no sandbox`. One vocabulary so the
 * label an operator sees cannot drift between `jaiph run`, `jaiph mcp`, and
 * `jaiph serve`.
 */
export function sandboxParenLabel(
  dockerEnabled: boolean,
  sandboxMode: SandboxMode | null,
  unsafeMode: boolean,
): string {
  if (!dockerEnabled) return unsafeMode ? "Docker sandbox, unsafe" : "no sandbox";
  if (sandboxMode === "inplace") return "Docker sandbox, in-place";
  return "Docker sandbox, snapshot";
}
